/**
 * Call notification records.
 *
 * Every call leaves exactly one `call` notification for the callee, created
 * when the offer arrives (`ringing`, or `requested` when the callee asks to
 * approve calls first) and updated in place as it progresses. A callee who was
 * offline still finds out they missed a call — the row is not created when the
 * phone rings, but when the offer reaches this instance.
 *
 * Only the initial insert is delivered (stream + push). Outcome updates are
 * silent: the notification is already on screen and must not buzz again.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { rowToNotification } from "@/lib/db";
import type { LocalNotification } from "@/lib/types";
import type { CallStatus, CallType } from "@/lib/types/call";

/** Deterministic id so a retried offer cannot create a second record. */
export function callNotificationId(callId: string): string {
  return `call-${callId}`;
}

export interface CallNotificationInput {
  callId: string;
  /** Who placed the call (the notification's `account` — what the UI shows). */
  callerId: string;
  /** Who received it. */
  calleeId: string;
  callType: CallType;
  status: CallStatus;
}

export function buildCallNotification(input: CallNotificationInput): LocalNotification {
  return {
    id: callNotificationId(input.callId),
    type: "call",
    accountId: input.callerId,
    targetAccountId: input.calleeId,
    objectId: input.callId,
    read: false,
    callStatus: input.status,
    callType: input.callType,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Record how the call ended, without re-delivering. A missing row is normal
 * (the offer never reached us in a form that stored one) and is not an error.
 */
export async function updateCallNotificationStatus(
  db: D1Database,
  callId: string,
  calleeId: string,
  status: CallStatus
): Promise<void> {
  await db
    .prepare(
      `UPDATE notifications SET call_status = ?
        WHERE object_id = ? AND target_account_id = ? AND type = 'call'`
    )
    .bind(status, callId, calleeId)
    .run();
}

/** The callee's record of a call, if this instance stored one. */
export async function getCallNotification(
  db: D1Database,
  callId: string,
  calleeId: string
): Promise<LocalNotification | null> {
  const row = await db
    .prepare(
      `SELECT * FROM notifications
        WHERE object_id = ? AND target_account_id = ? AND type = 'call'`
    )
    .bind(callId, calleeId)
    .first<Record<string, unknown>>();
  return row ? rowToNotification(row) : null;
}
