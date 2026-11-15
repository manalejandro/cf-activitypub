import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import {
  DELETE as unblock,
  GET as listBlocks,
  POST as block,
} from "@/app/api/v1/admin/canonical_email_blocks/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ADMIN = `${BASE}/users/root`;
const MODERATOR = `${BASE}/users/mod`;
const TOKEN = "tok-admin";
const MOD_TOKEN = "tok-mod";
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
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, role, email, email_verified)
       VALUES (?, 'mod', ?, 'pub', 'priv', 1, 'moderator', 'mod@example.test', 1)`
    )
    .bind(MODERATOR, new URL(BASE).hostname)
    .run();
  await db
    .prepare("INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))")
    .bind("t-mod", MODERATOR, MOD_TOKEN)
    .run();
}

function req(method: string, url: string): NextRequest {
  return new NextRequest(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
}

function reqAs(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

  /**
   * A blocked mailbox explains a rejected sign-up, so support has to be able to
   * read the list; only an administrator may change it (a block silently refuses
   * registrations). Moderators got a 403 on the whole section, which is why the
   * page looked "broken" for them.
   */
  it("lets a moderator read the list but not mutate it", async () => {
    await db
      .prepare("INSERT INTO canonical_email_blocks (hash, reference_email, reason) VALUES (?, ?, ?)")
      .bind(HASH, "prueba2@example.test", "Repeated registrations")
      .run();
    const url = `${BASE}/api/v1/admin/canonical_email_blocks`;

    const read = await listBlocks(reqAs("GET", url, MOD_TOKEN));
    expect(read.status).toBe(200);
    expect(((await read.json()) as unknown[])).toHaveLength(1);

    const remove = await unblock(reqAs("DELETE", `${url}?hash=${HASH}`, MOD_TOKEN));
    expect(remove.status).toBe(403);

    const add = await block(reqAs("POST", url, MOD_TOKEN, { email: "other@example.test" }));
    expect(add.status).toBe(403);

    // Nothing changed: the row survives and no mutation was audited.
    const left = await db.prepare("SELECT COUNT(*) AS n FROM canonical_email_blocks").first<{ n: number }>();
    expect(left?.n).toBe(1);
    const logged = await db
      .prepare("SELECT COUNT(*) AS n FROM moderation_log WHERE target_type = 'email'")
      .first<{ n: number }>();
    expect(logged?.n).toBe(0);
  });

  it("refuses an anonymous reader", async () => {
    const res = await listBlocks(new NextRequest(`${BASE}/api/v1/admin/canonical_email_blocks`));
    expect(res.status).toBe(401);
  });
});
