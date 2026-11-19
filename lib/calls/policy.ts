/**
 * Call reachability policy.
 *
 * The callee decides who may ring them (`calls:policy`), which media their
 * callers may use (`calls:allow_audio|video|screen`) and at what volume they
 * hear the peer (`calls:volume`). The policy is enforced twice:
 *
 *  - `POST /api/v1/calls` for a local callee (an instant answer, before any
 *    session or notification exists);
 *  - the inbound `CallOffer` handler for a remote caller ringing a local
 *    account (the reject travels back federated).
 *
 * A remote callee's policy is unknown to us — their instance applies it when
 * the `CallOffer` arrives — so calls to a remote account are always attempted.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { isBlocked } from "@/lib/db";
import type { CallType } from "@/lib/types/call";

/**
 * Structural KV shape: the ambient worker binding and the packaged
 * `KVNamespace` type are not assignable to each other, so the allowlist
 * helpers accept the two methods they actually use.
 */
export interface CallKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type CallPolicy = "nobody" | "request" | "everyone";

export interface CallPreferences {
  policy: CallPolicy;
  allowAudio: boolean;
  allowVideo: boolean;
  allowScreen: boolean;
  /** Playback volume of the remote peer, 0-100. */
  volume: number;
}

export const DEFAULT_CALL_PREFERENCES: Readonly<CallPreferences> = {
  policy: "nobody",
  allowAudio: true,
  allowVideo: true,
  allowScreen: true,
  volume: 100,
};

const POLICIES = new Set<CallPolicy>(["nobody", "request", "everyone"]);

/**
 * The "asked first" allowlist: a caller the callee approved once may call
 * again without asking. 30 days matches the window a contact is likely to
 * remember; no UI revokes it in this batch.
 */
export const CALL_APPROVAL_TTL_SECONDS = 30 * 24 * 60 * 60;

export function callApprovalKey(calleeId: string, callerId: string): string {
  return `call:allow:${calleeId}:${callerId}`;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "true";
}

/** Read every `calls:*` preference of an actor in one query. */
export async function getCallPreferences(db: D1Database, actorId: string): Promise<CallPreferences> {
  const rows = await db
    .prepare("SELECT key, value FROM preferences WHERE actor_id = ? AND key LIKE 'calls:%'")
    .bind(actorId)
    .all<{ key: string; value: string }>();
  const stored = new Map<string, string>();
  for (const row of rows.results ?? []) stored.set(row.key, row.value);

  const policy = stored.get("calls:policy");
  const volume = Number(stored.get("calls:volume"));

  return {
    policy: policy && POLICIES.has(policy as CallPolicy) ? (policy as CallPolicy) : DEFAULT_CALL_PREFERENCES.policy,
    allowAudio: parseBoolean(stored.get("calls:allow_audio"), DEFAULT_CALL_PREFERENCES.allowAudio),
    allowVideo: parseBoolean(stored.get("calls:allow_video"), DEFAULT_CALL_PREFERENCES.allowVideo),
    allowScreen: parseBoolean(stored.get("calls:allow_screen"), DEFAULT_CALL_PREFERENCES.allowScreen),
    volume: Number.isFinite(volume) && volume >= 0 && volume <= 100
      ? Math.round(volume)
      : DEFAULT_CALL_PREFERENCES.volume,
  };
}

/**
 * Whether the callee allows this kind of call. A video call's audio track
 * rides the video permission (the toggles are per call type, not per track),
 * which is what the settings page presents them as.
 */
export function callMediaAllowed(prefs: CallPreferences, callType: CallType): boolean {
  switch (callType) {
    case "audio":
      return prefs.allowAudio;
    case "video":
      return prefs.allowVideo;
    case "screen":
      return prefs.allowScreen;
    default:
      return false;
  }
}

export type CallDenialReason = "nobody" | "media_disabled" | "silenced" | "blocked";

export type CallPermissionResult =
  /** The call may ring right away. */
  | { result: "allowed" }
  /** The callee asked to approve calls first; hold the offer until they answer. */
  | { result: "approval_required" }
  /** Refuse the call outright. */
  | { result: "denied"; reason: CallDenialReason };

export interface CallPermissionInput {
  db: D1Database;
  kv?: CallKvNamespace | null;
  calleeId: string;
  callerId: string;
  callType: CallType;
  /** Limited (silenced) accounts are not allowed to ring anyone. */
  callerSilenced?: boolean;
  /** The callee's preferences, when the caller already loaded them. */
  prefs?: CallPreferences;
}

/**
 * Resolve whether `callerId` may ring `calleeId`, and how.
 *
 * Order matters: a silenced caller and a block are refusals no preference can
 * override; the media permission comes before the reachability policy so the
 * caller learns "video calls are off" rather than "ask first" for a call that
 * would be refused anyway.
 */
export async function evaluateCallPermission(input: CallPermissionInput): Promise<CallPermissionResult> {
  const { db, kv, calleeId, callerId, callType } = input;

  if (input.callerSilenced) return { result: "denied", reason: "silenced" };
  if (await isBlocked(db, calleeId, callerId)) return { result: "denied", reason: "blocked" };

  const prefs = input.prefs ?? (await getCallPreferences(db, calleeId));
  if (!callMediaAllowed(prefs, callType)) return { result: "denied", reason: "media_disabled" };

  switch (prefs.policy) {
    case "everyone":
      return { result: "allowed" };
    case "request":
      return (await hasCallApproval(kv, calleeId, callerId))
        ? { result: "allowed" }
        : { result: "approval_required" };
    case "nobody":
    default:
      return { result: "denied", reason: "nobody" };
  }
}

export async function hasCallApproval(
  kv: CallKvNamespace | null | undefined,
  calleeId: string,
  callerId: string
): Promise<boolean> {
  if (!kv) return false;
  try {
    return (await kv.get(callApprovalKey(calleeId, callerId))) !== null;
  } catch {
    // A KV failure must not turn into a refused call; treating it as "not
    // approved" only means the caller asks again.
    return false;
  }
}

export async function rememberCallApproval(
  kv: CallKvNamespace | null | undefined,
  calleeId: string,
  callerId: string
): Promise<void> {
  if (!kv) return;
  await kv
    .put(callApprovalKey(calleeId, callerId), new Date().toISOString(), {
      expirationTtl: CALL_APPROVAL_TTL_SECONDS,
    })
    .catch(() => {});
}

/** Stable `error_code` (an i18n key) for a refusal, so clients can localise it. */
export function callDenialErrorCode(reason: CallDenialReason): string {
  switch (reason) {
    case "nobody":
      return "call_error_policy_nobody";
    case "media_disabled":
      return "call_error_media_disabled";
    case "silenced":
      return "call_error_caller_limited";
    case "blocked":
      return "call_error_blocked";
  }
}
