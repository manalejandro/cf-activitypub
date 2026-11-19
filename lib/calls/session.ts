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
