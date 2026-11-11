import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { DELETE as unblock, GET as listBlocks } from "@/app/api/v1/admin/canonical_email_blocks/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ADMIN = `${BASE}/users/root`;
const TOKEN = "tok-admin";
const HASH = "a".repeat(64);

async function seedAdmin() {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, role, email, email_verified)
       VALUES (?, 'root', ?, 'pub', 'priv', 1, 'admin', 'root@example.test', 1)`
    )
    .bind(ADMIN, new URL(BASE).hostname)
    .run();
  await db
    .prepare("INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))")
    .bind("t-admin", ADMIN, TOKEN)
    .run();
}

function req(method: string, url: string): NextRequest {
  return new NextRequest(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
}

beforeEach(async () => {
  await resetTestStorage();
  await seedAdmin();
});

describe("admin canonical email blocks", () => {
  it("lists the blocked mailboxes", async () => {
    await db
      .prepare("INSERT INTO canonical_email_blocks (hash, reference_email, reason) VALUES (?, ?, ?)")
      .bind(HASH, "prueba2@example.test", "Repeated registrations from the same mailbox")
      .run();

    const res = await listBlocks(req("GET", `${BASE}/api/v1/admin/canonical_email_blocks`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hash: string; reference_email: string; reason: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ hash: HASH, reference_email: "prueba2@example.test" });
  });

  /**
   * Unblocking must also clear the KV attempt counter: with the row gone but
   * the counter still at 3, the next attempt sees `priorAttempts >= 2`, refuses
   * again and re-creates the block — the admin's "unblock" would look broken
   * for up to 24 hours (the counter's TTL).
   */
  it("unblocking clears the attempt counter with the row", async () => {
    await db
      .prepare("INSERT INTO canonical_email_blocks (hash, reference_email, reason) VALUES (?, ?, ?)")
      .bind(HASH, "prueba2@example.test", "Repeated registrations from the same mailbox")
      .run();
    await env.KV.put(`canonical:reg:${HASH}`, "3", { expirationTtl: 86400 });

    const res = await unblock(req("DELETE", `${BASE}/api/v1/admin/canonical_email_blocks?hash=${HASH}`));
    expect(res.status).toBe(200);

    const left = await db.prepare("SELECT COUNT(*) AS n FROM canonical_email_blocks").first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await env.KV.get(`canonical:reg:${HASH}`)).toBeNull();
  });

  it("refuses a non-admin and a malformed hash", async () => {
    const anonymous = await unblock(new NextRequest(`${BASE}/api/v1/admin/canonical_email_blocks?hash=${HASH}`, { method: "DELETE" }));
    expect(anonymous.status).toBe(401);

    const bad = await unblock(req("DELETE", `${BASE}/api/v1/admin/canonical_email_blocks?hash=not-a-hash`));
    expect(bad.status).toBe(422); // `badRequest()` in lib/cf answers 422
  });
});
