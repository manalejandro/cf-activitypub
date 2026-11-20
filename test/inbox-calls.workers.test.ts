import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { broadcastEvent } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

/** In-memory KV namespace (keys, optional TTL). */
function makeKv(): {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const db = env.DB;
const BASE = "https://local.example.test";
const REMOTE_ACTOR = "https://remote.example/users/alice";
const LOCAL_ACTOR = `${BASE}/users/bob`;
const CALL_ID = "4f9a2c3d-0000-0000-0000-000000000001";

async function freshDb(): Promise<void> {
  await resetTestDatabase();
  const insertActor = db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local) VALUES (?, ?, ?, ?, ?, ?)`
  );
  await insertActor.bind(REMOTE_ACTOR, "alice", "remote.example", "key-alice", null, 0).run();
  await insertActor.bind(LOCAL_ACTOR, "bob", "local.example.test", "key-bob", "priv-bob", 1).run();
}

function makeCallActivity(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${REMOTE_ACTOR}/activities/${type.toLowerCase()}-1`,
    type,
    actor: REMOTE_ACTOR,
    to: [LOCAL_ACTOR],
    object: {
      type: "CallSession",
      id: `${BASE}/calls/${CALL_ID}`,
      callType: "video",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1",
    },
    ...overrides,
  };
}

const timelineStream = {} as never;

/**
 * KV seeded with a call session. The defaults describe a call placed *to* us
 * (remote caller, local callee); answer/ringing/reject tests seed the reverse
 * direction, because only the callee may answer.
 */
async function makeCallKv(
  overrides: Record<string, unknown> = {}
): Promise<ReturnType<typeof makeKv>> {
  const kv = makeKv();
  await kv.put(
    `call:${CALL_ID}`,
    JSON.stringify({
      id: CALL_ID,
      callerId: REMOTE_ACTOR,
      calleeId: LOCAL_ACTOR,
      state: "pending",
      ...overrides,
    })
  );
  return kv;
}

/** The callee's record of an incoming call, as `handleCallOffer` writes it. */
async function seedCallNotification(status = "ringing"): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, type, account_id, target_account_id, object_id, call_status, call_type)
       VALUES (?, 'call', ?, ?, ?, ?, 'video')`
    )
    .bind(`call-${CALL_ID}`, REMOTE_ACTOR, LOCAL_ACTOR, CALL_ID, status)
    .run();
}

async function callStatus(): Promise<string | null> {
  const row = await db
    .prepare("SELECT call_status FROM notifications WHERE object_id = ? AND type = 'call'")
    .bind(CALL_ID)
    .first<{ call_status: string | null }>();
  return row?.call_status ?? null;
}

beforeAll(async () => {
  await freshDb();
});

beforeEach(async () => {
  await freshDb();
  (broadcastEvent as ReturnType<typeof vi.fn>).mockClear();
});

/** Let remote callers ring the local account (the default is `nobody`). */
async function allowAllCalls(callType?: "audio" | "video" | "screen"): Promise<void> {
  const insert = db.prepare("INSERT INTO preferences (actor_id, key, value) VALUES (?, ?, ?)");
  await insert.bind(LOCAL_ACTOR, "calls:policy", "everyone").run();
  if (callType) {
    await insert.bind(LOCAL_ACTOR, `calls:allow_${callType}`, "true").run();
  }
}

describe("call negotiation inbox handling", () => {
  it("persists a call session and broadcasts call.incoming for CallOffer", async () => {
    await allowAllCalls();
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.incoming");
    expect(event.callId).toBe(CALL_ID);
    expect(event.callType).toBe("video");
    expect(event.callerAcct).toBe("alice@remote.example");
    expect(event.offerSdp).toContain("v=0");

    // Session persisted so the callee can answer against their own instance
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.callerId).toBe(REMOTE_ACTOR);
    expect(session.calleeId).toBe(LOCAL_ACTOR);
    expect(session.state).toBe("pending");

    // Both peers are busy from the moment the session exists, not only once
    // the call is answered.
    expect(await kv.get(`call:active:${REMOTE_ACTOR}`)).toBe(CALL_ID);
    expect(await kv.get(`call:active:${LOCAL_ACTOR}`)).toBe(CALL_ID);
  });

  it("refuses a CallOffer when the callee is already in another call", async () => {
    await allowAllCalls();
    const kv = makeKv();
    const otherCall = "another-call";
    await kv.put(
      `call:${otherCall}`,
      JSON.stringify({
        id: otherCall,
        callerId: "https://remote.example/users/carol",
        calleeId: LOCAL_ACTOR,
        callerAcct: "carol@remote.example",
        calleeAcct: "bob",
        callType: "audio",
        offerSdp: "v=0",
        answerSdp: "v=0",
        state: "active",
        createdAt: new Date().toISOString(),
      })
    );
    await kv.put(`call:active:${LOCAL_ACTOR}`, otherCall);
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastEvent).not.toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).toBeNull();
    const notifications = await db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE target_account_id = ?")
      .bind(LOCAL_ACTOR)
      .first<{ n: number }>();
    expect(notifications?.n).toBe(0);
  });

  it("ignores a busy marker whose call session is gone", async () => {
    // A marker left behind by a call that died without a hangup used to reject
    // every later offer with "busy" for the rest of its TTL.
    await allowAllCalls();
    const kv = makeKv();
    await kv.put(`call:active:${LOCAL_ACTOR}`, "vanished-call");

    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastEvent).toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).not.toBeNull();
    expect(await kv.get(`call:active:${LOCAL_ACTOR}`)).toBe(CALL_ID);
  });

  it("does not reset a call that already progressed when the offer is retried", async () => {
    await allowAllCalls();
    const kv = await makeCallKv({ state: "active", answerSdp: "answer-sdp-1" });
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastEvent).not.toHaveBeenCalled();
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("active");
    expect(session.answerSdp).toBe("answer-sdp-1");
  });

  it("does nothing for CallOffer without a recipient (shared inbox)", async () => {
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, { db, baseUrl: BASE, kv } as never);
    expect(broadcastEvent).not.toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).toBeNull();
  });

  it("refuses a CallOffer under the default nobody policy", async () => {
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastEvent).not.toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).toBeNull();
    const notifications = await db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE target_account_id = ?")
      .bind(LOCAL_ACTOR)
      .first<{ n: number }>();
    expect(notifications?.n).toBe(0);
  });

  it("holds a CallOffer as requested when the callee asks to approve calls", async () => {
    const insert = db.prepare("INSERT INTO preferences (actor_id, key, value) VALUES (?, ?, ?)");
    await insert.bind(LOCAL_ACTOR, "calls:policy", "request").run();
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    const [, , type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(type).toBe("call");
    expect((payload as Record<string, unknown>).type).toBe("call.request");
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("requested");
  });

  it("broadcasts call.answered for a CallAnswer signed by the callee", async () => {
    // The local account placed the call, so the remote peer is the callee and
    // the only actor allowed to answer it.
    const kv = await makeCallKv({ callerId: LOCAL_ACTOR, calleeId: REMOTE_ACTOR });
    await processInboxActivity(
      makeCallActivity("CallAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "answer-sdp-1" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe(CALL_ID);
    expect(event.answerSdp).toBe("answer-sdp-1");

    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("active");
    expect(session.answerSdp).toBe("answer-sdp-1");
  });

  it("ignores a CallAnswer signed by the caller (only the callee may answer)", async () => {
    // Default session: the remote actor is the caller, so its own answer is a
    // forgery and must not activate the call.
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "forged-answer" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).not.toHaveBeenCalled();
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("pending");
    expect(session.answerSdp).toBeUndefined();
  });

  it("does not reopen a call that already ended with a late CallAnswer", async () => {
    const kv = await makeCallKv({ callerId: LOCAL_ACTOR, calleeId: REMOTE_ACTOR, state: "ended" });
    await processInboxActivity(
      makeCallActivity("CallAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "late-answer" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).not.toHaveBeenCalled();
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("ended");
  });

  it("broadcasts call.ice with a parsed candidate for CallIceCandidate", async () => {
    const candidate = { candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallIceCandidate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, candidate: JSON.stringify(candidate) },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.ice");
    expect(event.callId).toBe(CALL_ID);
    expect(event.candidate).toEqual(candidate);
  });

  it("drops a CallIceCandidate with no candidate payload", async () => {
    await processInboxActivity(
      makeCallActivity("CallIceCandidate") as never,
      { db, baseUrl: BASE, timelineStream } as never
    );
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("drops a malformed ICE candidate instead of failing the delivery", async () => {
    const kv = await makeCallKv();
    // A bad peer must not throw out of the inbox handler (the sender would be
    // retried forever and the whole activity would fail).
    await expect(
      processInboxActivity(
        makeCallActivity("CallIceCandidate", {
          object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, candidate: "{not-json" },
        }) as never,
        { db, baseUrl: BASE, kv, timelineStream } as never
      )
    ).resolves.toBeUndefined();
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("broadcasts call.ended for CallHangup", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallHangup") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.ended");
    expect(event.callId).toBe(CALL_ID);
  });

  it("records an answered outcome when an active call is hung up", async () => {
    const kv = await makeCallKv({ state: "active" });
    await kv.put(`call:active:${REMOTE_ACTOR}`, CALL_ID);
    await kv.put(`call:active:${LOCAL_ACTOR}`, CALL_ID);
    await seedCallNotification("ringing");

    await processInboxActivity(
      makeCallActivity("CallHangup") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(await callStatus()).toBe("answered");
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("ended");
    // The call is over: both peers may start another one.
    expect(await kv.get(`call:active:${REMOTE_ACTOR}`)).toBeNull();
    expect(await kv.get(`call:active:${LOCAL_ACTOR}`)).toBeNull();
  });

  it("records an unanswered outcome when a held request is hung up", async () => {
    const kv = await makeCallKv({ state: "requested" });
    await seedCallNotification("requested");

    await processInboxActivity(
      makeCallActivity("CallHangup") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(await callStatus()).toBe("unanswered");
  });

  it("broadcasts call.renegotiate for CallRenegotiate (mid-call track add)", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallRenegotiate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reoffer-sdp" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reoffer-sdp");
  });

  it("broadcasts call.renegotiate-answer for CallRenegotiateAnswer", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallRenegotiateAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reanswer-sdp" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate-answer");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reanswer-sdp");
  });

  it("moves a held request to ringing for CallRinging", async () => {
    // Our local account placed the call; the remote callee approved it.
    const kv = await makeCallKv({ callerId: LOCAL_ACTOR, calleeId: REMOTE_ACTOR, state: "requested" });
    await processInboxActivity(
      makeCallActivity("CallRinging") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, , , payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((payload as Record<string, unknown>).type).toBe("call.ringing");
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("pending");
  });

  it("never downgrades an active call with a late CallRinging", async () => {
    const kv = await makeCallKv({
      callerId: LOCAL_ACTOR,
      calleeId: REMOTE_ACTOR,
      state: "active",
      answerSdp: "answer-sdp-1",
    });
    await processInboxActivity(
      makeCallActivity("CallRinging") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).not.toHaveBeenCalled();
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("active");
  });

  it("forwards the peer's refusal reason in call.rejected", async () => {
    const kv = await makeCallKv({ callerId: LOCAL_ACTOR, calleeId: REMOTE_ACTOR });
    await processInboxActivity(
      makeCallActivity("CallReject", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, reason: "busy" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.rejected");
    expect(event.callId).toBe(CALL_ID);
    expect(event.reason).toBe("busy");
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.state).toBe("rejected");
  });

  it("drops call events from an actor outside the call session", async () => {
    const other = "https://evil.example/users/mallory";
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local) VALUES (?,?,?,?,?,?)")
      .bind(other, "mallory", "evil.example", "key-m", null, 0)
      .run();
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallHangup", { actor: other, id: `${other}/activities/hangup-1` }) as never,
      { db, baseUrl: BASE, kv, timelineStream, signingActorId: other } as never
    );
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("processes a replayed activity id only once", async () => {
    const kv = await makeCallKv();
    const activity = makeCallActivity("CallHangup");
    const ctx = { db, baseUrl: BASE, kv, timelineStream } as never;
    await processInboxActivity(activity as never, ctx);
    await processInboxActivity(activity as never, ctx);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
  });
});