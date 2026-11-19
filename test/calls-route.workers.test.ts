import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/v1/calls/route";

const BASE = "https://cf-ap.com";
const DOMAIN = "cf-ap.com";
const ME = `${BASE}/users/alice`;
const CALLEE = `${BASE}/users/bob`;
const TOKEN = "call-token";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  const insertActor = env.DB.prepare(
    "INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email_verified) VALUES (?, ?, ?, 'k', 'pk', 1, 1)"
  );
  await insertActor.bind(ME, "alice", DOMAIN).run();
  await insertActor.bind(CALLEE, "bob", DOMAIN).run();
  await env.DB
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, access_token, refresh_token, scope, expires_at, created_at) VALUES ('t1', ?, ?, 'r1', 'read write', '2099-01-01T00:00:00Z', datetime('now'))"
    )
    .bind(ME, TOKEN)
    .run();
  // The callee accepts calls, so a successful POST is possible at all.
  await env.DB
    .prepare("INSERT INTO preferences (actor_id, key, value) VALUES (?, 'calls:policy', 'everyone')")
    .bind(CALLEE)
    .run();
});

function makeRequest(body: Record<string, unknown>): Request {
  return new Request(`${BASE}/api/v1/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/calls", () => {
  it("refuses to ring a callee that is already in a call", async () => {
    await env.KV.put(`call:active:${CALLEE}`, "another-call");

    const res = await POST(makeRequest({ target_acct: "bob", call_type: "audio", offer_sdp: "v=0" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("call_busy");
    expect(body.error_code).toBe("call_error_in_progress");

    // Nothing was created: no session, no marker for the caller, no record.
    expect(await env.KV.get(`call:active:${ME}`)).toBeNull();
    expect(await env.KV.get(`call:active:${CALLEE}`)).toBe("another-call");
    const notifications = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE target_account_id = ?")
      .bind(CALLEE)
      .first<{ n: number }>();
    expect(notifications?.n).toBe(0);
  });

  it("marks both peers busy as soon as the call is created", async () => {
    const res = await POST(makeRequest({ target_acct: "bob", call_type: "audio", offer_sdp: "v=0" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; state: string };
    expect(body.state).toBe("pending");

    // Ringing is enough to make both sides busy; waiting for the answer would
    // let a parallel call start while the first one is still ringing.
    expect(await env.KV.get(`call:active:${ME}`)).toBe(body.id);
    expect(await env.KV.get(`call:active:${CALLEE}`)).toBe(body.id);

    const session = JSON.parse((await env.KV.get(`call:${body.id}`))!);
    expect(session.state).toBe("pending");
    expect(session.callerId).toBe(ME);
    expect(session.calleeId).toBe(CALLEE);

    const record = await env.DB
      .prepare("SELECT call_status FROM notifications WHERE object_id = ? AND type = 'call'")
      .bind(body.id)
      .first<{ call_status: string }>();
    expect(record?.call_status).toBe("ringing");
  });
});
