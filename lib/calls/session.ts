/**
 * Call session storage (Workers KV).
 *
 * One key per call (`call:<id>`, 10-minute TTL) plus an "active call" marker
 * per participant (`call:active:<actorId>`) so an account cannot start two
 * calls at once. Both the REST routes and the federated inbox handlers read
 * and write the same session, so the helpers live here rather than in either.
 */

import type { CallSession } from "@/lib/types/call";

export const CALL_TTL = 600; // 10 minutes in seconds

/**
 * The slice of KV these helpers need. Typed structurally so both the Workers
 * `KVNamespace` and a test double satisfy it (the ambient and imported
 * Cloudflare types are not always structurally compatible).
 */
export interface CallKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export async function getCallSession(kv: CallKV, id: string): Promise<CallSession | null> {
  const raw = await kv.get(`call:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallSession;
  } catch {
    return null;
  }
}

export async function saveCallSession(kv: CallKV, session: CallSession): Promise<void> {
  await kv.put(`call:${session.id}`, JSON.stringify(session), { expirationTtl: CALL_TTL });
}

export async function deleteCallSession(kv: CallKV, id: string): Promise<void> {
  await kv.delete(`call:${id}`).catch(() => {});
}

/**
 * A call that never left the pre-answer state is dead. These are deliberately
 * twice the client's own timers (`RING_TIMEOUT_MS` 45 s, `REQUEST_TIMEOUT_MS`
 * 90 s in `lib/webrtc/use-call.ts`): a live call whose answer is still in
 * flight must never be reaped.
 */
const PRE_ANSWER_TIMEOUT_MS = { pending: 90_000, requested: 180_000 } as const;

function isAbandonedCall(session: CallSession): boolean {
  if (session.state === "ended" || session.state === "rejected") return true;
  if (session.state !== "pending" && session.state !== "requested") return false;
  const created = Date.parse(session.createdAt);
  if (!Number.isFinite(created)) return false;
  return Date.now() - created > PRE_ANSWER_TIMEOUT_MS[session.state];
}

/**
 * The call currently holding `actorId`, or null.
 *
 * A marker is only trusted while its session is alive and still relevant. The
 * marker and the session share a 10-minute TTL, but a call that failed before
 * the client could hang up (a 5xx, a closed tab, a network drop) leaves the
 * marker behind with nobody to clear it, and the retry then answered 409
 * `call_error_in_progress` for a call that no longer existed. Healing here
 * keeps a dead session from locking both peers out for the full TTL.
 */
export async function findActiveCall(kv: CallKV, actorId: string): Promise<CallSession | null> {
  const callId = await kv.get(`call:active:${actorId}`);
  if (!callId) return null;
  const session = await getCallSession(kv, callId);
  if (!session) {
    await kv.delete(`call:active:${actorId}`).catch(() => {});
    return null;
  }
  if (isAbandonedCall(session)) {
    await clearCallActiveMarkers(kv, session);
    await deleteCallSession(kv, session.id);
    return null;
  }
  return session;
}

/** Drop the "active call" markers so both peers can start new calls. */
export async function clearCallActiveMarkers(kv: CallKV, session: CallSession): Promise<void> {
  await Promise.all([
    kv.delete(`call:active:${session.callerId}`).catch(() => {}),
    kv.delete(`call:active:${session.calleeId}`).catch(() => {}),
  ]);
}

/** Mark both participants busy for the rest of the call's TTL. */
export async function setCallActiveMarkers(kv: CallKV, session: CallSession): Promise<void> {
  await Promise.all([
    kv.put(`call:active:${session.callerId}`, session.id, { expirationTtl: CALL_TTL }),
    kv.put(`call:active:${session.calleeId}`, session.id, { expirationTtl: CALL_TTL }),
  ]);
}
