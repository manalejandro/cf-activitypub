/**
 * /api/v1/calls/[id]
 *
 * GET  — retrieve call session details (for the callee to get offer SDP)
 * POST — send a signal: answer SDP, ICE candidates, or hangup
 * DELETE — hang up / reject the call
 */

import { type NextRequest } from "next/server";
import {
  getBaseUrl,
  json,
  badRequest,
  unauthorized,
  notFound,
  checkRateLimit,
} from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById } from "@/lib/db";
import { broadcastEvent, type DONamespace } from "@/lib/streaming/broadcast";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { rememberCallApproval } from "@/lib/calls/policy";
import { updateCallNotificationStatus } from "@/lib/calls/notifications";
import {
  clearCallActiveMarkers,
  getCallSession,
  saveCallSession,
  setCallActiveMarkers,
} from "@/lib/calls/session";
import type { CallSession, CallEventPayload } from "@/lib/types/call";
import { env } from "cloudflare:workers";

type RouteParams = { params: Promise<{ id: string }> };

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");

  // Only caller or callee may view
  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  return json(session);
}

// ── POST — signal ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");

  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  // ── Abuse protection ──────────────────────────────────────────────────────
  const { allowed } = await checkRateLimit(env.KV, `call:signal:${actor.id}:${id}`, 120, 60);
  if (!allowed) {
    return json({ error: "rate_limited", message: "Too many signals." }, 429);
  }

  // Ended sessions only accept idempotent hangup/reject (double-click retries),
  // everything else is rejected so stale clients can't mutate a dead call.
  const callEnded = session.state === "ended" || session.state === "rejected";
  if (callEnded && (body.type === "hangup" || body.type === "reject" || body.type === "deny")) {
    return json({ ok: true });
  }
  if (callEnded) {
    return json({ error: "Call has ended" }, 409);
  }

  const baseUrl = getBaseUrl(env);
  const isCaller = session.callerId === actor.id;
  const isCallee = session.calleeId === actor.id;

  switch (body.type) {
    case "answer": {
      if (!isCallee) return badRequest("Caller cannot send answer");
      if (!body.sdp) return badRequest("Missing sdp");
      if (session.answerSdp) return badRequest("Call already answered");
      // Answering a call the callee was asked to approve implies approval: the
      // two-step UI is approve → ring → answer, but a direct answer must work
      // too (a client may skip the explicit approval call).
      if (session.state === "requested") {
        await rememberCallApproval(env.KV, session.calleeId, session.callerId);
      }
      session.answerSdp = body.sdp;
      session.state = "active";
      await saveCallSession(env.KV, session);
      // Both peers are now busy — block them from starting a parallel call.
      await setCallActiveMarkers(env.KV, session);
      await updateCallNotificationStatus(env.DB, id, session.calleeId, "answered");

      // Notify caller
      await notifyPeer(env, session, session.callerId, baseUrl, {
        type: "call.answered",
        callId: id,
        answerSdp: body.sdp,
      });
      break;
    }

    // ── Requested calls: the callee approves or declines a held offer ──────
    case "approve": {
      if (!isCallee) return badRequest("Only the callee may approve a call");
      if (session.state !== "requested") return badRequest("Call is not awaiting approval");
      await rememberCallApproval(env.KV, session.calleeId, session.callerId);
      // Now a normal ringing call: the callee's devices ring and the caller
      // knows the request was accepted.
      session.state = "pending";
      await saveCallSession(env.KV, session);
      await updateCallNotificationStatus(env.DB, id, session.calleeId, "ringing");
      const callerActor = await getActorById(env.DB, session.callerId);

      await broadcastEvent(env.TIMELINE_STREAM, session.calleeId, "call", {
        type: "call.incoming",
        callId: id,
        callType: session.callType,
        callerAcct: session.callerAcct,
        callerDisplayName: callerActor?.displayName ?? callerActor?.username ?? session.callerAcct,
        callerAvatar: callerActor?.avatarUrl ?? null,
        offerSdp: session.offerSdp,
      } satisfies CallEventPayload);
      await notifyPeer(env, session, session.callerId, baseUrl, { type: "call.ringing", callId: id });
      break;
    }

    case "deny": {
      if (!isCallee) return badRequest("Only the callee may decline a call");
      if (session.state !== "requested") return badRequest("Call is not awaiting approval");
      session.state = "rejected";
      await saveCallSession(env.KV, session);
      await clearCallActiveMarkers(env.KV, session);
      await updateCallNotificationStatus(env.DB, id, session.calleeId, "declined");
      await notifyPeer(env, session, session.callerId, baseUrl, { type: "call.rejected", callId: id });
      // The callee's other tabs must stop showing the request too.
      await broadcastEvent(env.TIMELINE_STREAM, session.calleeId, "call", {
        type: "call.rejected",
        callId: id,
      } satisfies CallEventPayload);
      break;
    }

    case "ice": {
      if (!body.candidate) return badRequest("Missing candidate");
      const peerActorId = isCaller ? session.calleeId : session.callerId;

      // Relay ICE candidate via the signaling DO for same-instance calls
      // For cross-instance, federate via ActivityPub
      await notifyPeer(env, session, peerActorId, baseUrl, {
        type: "call.ice",
        callId: id,
        candidate: body.candidate,
      });

      // Also push to the CallSignalingDO WebSocket relay for low-latency delivery
      try {
        const doId = env.CALL_SIGNALING.idFromName(id);
        const stub = env.CALL_SIGNALING.get(doId);
        await stub.fetch(`https://call-do/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "ice", candidate: body.candidate }),
        });
      } catch { /* non-critical — WebSocket relay is best-effort */ }
      break;
    }

    case "hangup":
    case "reject": {
      // The callee's record must say how the call ended while the state still
      // knows it: cancelling a ringing call is a miss, cancelling one that was
      // waiting for approval is "unanswered", and an answered call keeps
      // "answered".
      const previousState = session.state;
      session.state = body.type === "reject" ? "rejected" : "ended";
      await saveCallSession(env.KV, session);
      await clearCallActiveMarkers(env.KV, session);
      if (body.type === "reject") {
        await updateCallNotificationStatus(env.DB, id, session.calleeId, "declined");
      } else if (previousState === "requested") {
        // The caller gave up waiting for approval vs. the callee dropped the
        // request themselves (already a refusal).
        await updateCallNotificationStatus(env.DB, id, session.calleeId, isCaller ? "unanswered" : "declined");
      } else if (previousState === "pending") {
        await updateCallNotificationStatus(env.DB, id, session.calleeId, "missed");
      }

      const peerActorId = isCaller ? session.calleeId : session.callerId;
      const eventType = body.type === "reject" ? "call.rejected" : "call.ended";
      await notifyPeer(env, session, peerActorId, baseUrl, {
        type: eventType as "call.rejected" | "call.ended",
        callId: id,
      });
      // Stop the actor's other tabs/devices as well (the peer got its event
      // above); without this a second tab keeps ringing until the session TTL.
      await broadcastEvent(env.TIMELINE_STREAM, actor.id, "call", {
        type: eventType,
        callId: id,
      } satisfies CallEventPayload);

      // Also signal via DO WebSocket
      try {
        const doId = env.CALL_SIGNALING.idFromName(id);
        const stub = env.CALL_SIGNALING.get(doId);
        await stub.fetch(`https://call-do/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "hangup" }),
        });
      } catch { /* best-effort */ }
      break;
    }

    // ── Mid-call renegotiation (adding/removing tracks on demand) ──────────
    // Sent via REST so it works for both same-instance (streaming relay) and
    // cross-instance (federated CallRenegotiate / CallRenegotiateAnswer).
    case "renegotiate":
    case "renegotiate-answer": {
      if (!body.sdp) return badRequest("Missing sdp");
      if (session.state !== "active") return badRequest("Call is not active");
      const peerActorId = isCaller ? session.calleeId : session.callerId;
      const eventType = body.type === "renegotiate" ? "call.renegotiate" : "call.renegotiate-answer";
      await notifyPeer(env, session, peerActorId, baseUrl, {
        type: eventType as "call.renegotiate" | "call.renegotiate-answer",
        callId: id,
        sdp: body.sdp,
      });
      break;
    }

    default:
      return badRequest("Unknown signal type");
  }

  // Send signal AP activity for cross-instance federation (answer, ice, hangup, reject)
  const peerActorId = isCaller ? session.calleeId : session.callerId;
  const isPeerRemote = !peerActorId.startsWith(baseUrl);
  if (isPeerRemote) {
    const peerActor = await getActorById(env.DB, peerActorId);
    if (peerActor?.inbox) {
      const apActivity = buildSignalActivity(baseUrl, actor.id, peerActorId, id, body);
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [peerActor.inbox],
        JSON.stringify(apActivity),
        actor.id,
        `${actor.id}#main-key`,
        actor.privateKeyPem
      ).catch(() => {});
    }
  }

  return json({ ok: true });
}

// ── DELETE — hang up ──────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");
  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  // Idempotent: a repeated hangup (double-click) must not re-notify peers.
  if (session.state === "ended" || session.state === "rejected") {
    return new Response(null, { status: 204 });
  }

  const previousState = session.state;
  const actorIsCaller = session.callerId === actor.id;
  session.state = "ended";
  await saveCallSession(env.KV, session);
  await clearCallActiveMarkers(env.KV, session);
  if (previousState === "requested") {
    await updateCallNotificationStatus(env.DB, id, session.calleeId, actorIsCaller ? "unanswered" : "declined");
  } else if (previousState === "pending") {
    await updateCallNotificationStatus(env.DB, id, session.calleeId, "missed");
  }

  const baseUrl = getBaseUrl(env);
  const peerActorId = session.callerId === actor.id ? session.calleeId : session.callerId;
  await notifyPeer(env, session, peerActorId, baseUrl, { type: "call.ended", callId: id });
  await broadcastEvent(env.TIMELINE_STREAM, actor.id, "call", { type: "call.ended", callId: id });

  // Cross-instance federation for hangup via DELETE
  const isPeerRemote = !peerActorId.startsWith(baseUrl);
  if (isPeerRemote) {
    const peerActor = await getActorById(env.DB, peerActorId);
    if (peerActor?.inbox) {
      const apActivity = buildSignalActivity(baseUrl, actor.id, peerActorId, id, { type: "hangup" });
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [peerActor.inbox],
        JSON.stringify(apActivity),
        actor.id,
        `${actor.id}#main-key`,
        actor.privateKeyPem
      ).catch(() => {});
    }
  }

  try {
    const doId = env.CALL_SIGNALING.idFromName(id);
    const stub = env.CALL_SIGNALING.get(doId);
    await stub.fetch(`https://call-do/relay`, {
      method: "POST",
      body: JSON.stringify({ type: "hangup" }),
      headers: { "Content-Type": "application/json" },
    });
  } catch { /* best-effort */ }

  return new Response(null, { status: 204 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notifyPeer(
  env: { TIMELINE_STREAM: DONamespace },
  session: CallSession,
  peerActorId: string,
  baseUrl: string,
  event: CallEventPayload
): Promise<void> {
  // Compare full origins: `getDomain` drops the port, so a dev instance at
  // `http://127.0.0.1:3000` never matched and local peers were skipped.
  const origin = baseUrl.replace(/\/+$/, "");
  if (!peerActorId.startsWith(`${origin}/`)) return; // Cross-instance handled separately via AP

  try {
    await broadcastEvent(env.TIMELINE_STREAM, peerActorId, "call", event);
  } catch {
    // skip
  }
}

function buildSignalActivity(
  baseUrl: string,
  actorId: string,
  toActorId: string,
  callId: string,
  signal: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }
): object {
  const typeMap: Record<string, string> = {
    answer: "CallAnswer",
    ice: "CallIceCandidate",
    hangup: "CallHangup",
    reject: "CallReject",
    deny: "CallReject",
    approve: "CallRinging",
    renegotiate: "CallRenegotiate",
    "renegotiate-answer": "CallRenegotiateAnswer",
  };
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${baseUrl}/calls/${callId}#${signal.type}-${Date.now()}`,
    type: typeMap[signal.type] ?? "CallSignal",
    actor: actorId,
    to: [toActorId],
    object: {
      type: "CallSession",
      id: `${baseUrl}/calls/${callId}`,
      ...(signal.sdp ? { sdp: signal.sdp } : {}),
      ...(signal.candidate ? { candidate: JSON.stringify(signal.candidate) } : {}),
    },
  };
}
