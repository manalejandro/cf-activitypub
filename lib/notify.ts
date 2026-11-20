import type { D1Database } from "@cloudflare/workers-types";
import { createNotification, getActorById, getObjectById } from "@/lib/db";
import type { LocalNotification } from "@/lib/types";
import { broadcastNotificationEvent, type DONamespace } from "@/lib/streaming/broadcast";
import { serializeNotification } from "@/lib/mastodon/serializers";
import { deliverPushSafe } from "@/lib/push";

export interface NotifyEnv {
  DB: D1Database;
  INSTANCE_URL?: string;
  TIMELINE_STREAM?: DONamespace;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_EMAIL?: string;
}

/**
 * Serialize a notification to its Mastodon REST shape so streaming clients
 * receive the full payload (Mastodon sends the complete Notification entity
 * on the `notification` event).
 */
async function serializeFullNotification(
  db: D1Database,
  notif: LocalNotification,
  fallbackDomain: string
): Promise<string> {
  try {
    const [fromActor, target, object] = await Promise.all([
      getActorById(db, notif.accountId),
      getActorById(db, notif.targetAccountId),
      // A call notification's objectId is the call UUID, never an object row.
      notif.type !== "call" && notif.objectId
        ? getObjectById(db, notif.objectId)
        : Promise.resolve(null),
    ]);
    if (!fromActor) return "{}";
    const localDomain = target?.isLocal && target.domain ? target.domain : fallbackDomain;
    // The object's author (the status card of a mention/quote notification
    // renders the replied-to/quoted account) — derived from the object read
    // above; this used to fetch the SAME object a second time per
    // notification.
    const author = object ? await getActorById(db, object.actorId) : null;
    return JSON.stringify(serializeNotification(notif, fromActor, localDomain, object ?? undefined, author ?? undefined));
  } catch {
    return "{}";
  }
}

export async function notify(env: NotifyEnv, notif: LocalNotification): Promise<void> {
  // A filtered notification (limited-account policy) is stored but must not
  // reach the recipient's stream or devices.
  let stored: boolean;
  try {
    stored = await createNotification(env.DB, notif);
  } catch (err) {
    // The record is enrichment: the action that produced it (a follow, a call,
    // a favourite) is already committed, and failing it with a 500 makes the
    // client retry the whole action for a notification it would not have shown
    // anyway. A schema drift or a transient D1 error is logged here instead.
    console.error("[notify] could not store notification:", notif.type, notif.id, err);
    return;
  }
  if (!stored) return;
  if (env.TIMELINE_STREAM) {
    let domain = "localhost";
    try {
      if (env.INSTANCE_URL) domain = new URL(env.INSTANCE_URL).hostname;
    } catch { /* keep fallback */ }
    const payload = await serializeFullNotification(env.DB, notif, domain);
    void broadcastNotificationEvent(env.TIMELINE_STREAM, notif.targetAccountId, payload).catch(() => {});
  }
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_EMAIL) {
    void deliverPushSafe(env.DB, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_EMAIL, notif);
  }
}