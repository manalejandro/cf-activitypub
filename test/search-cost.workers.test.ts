import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { GET as search } from "@/app/api/v2/search/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const TOKEN = "tok-search";

type Results = {
  accounts: { id: string }[];
  statuses: { id: string; content: string }[];
  hashtags: { name: string }[];
  collections: unknown[];
};

async function seedActor(id: string, opts: { suspended?: boolean; silenced?: boolean } = {}) {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, suspended, silenced,
         role, email, email_verified)
       VALUES (?, ?, ?, 'pub', 'priv', 1, ?, ?, 'user', ?, 1)`
    )
    .bind(id, username, new URL(id).hostname, opts.suspended ? 1 : 0, opts.silenced ? 1 : 0, `${username}@example.test`)
    .run();
}

async function seedObject(id: string, actorId: string, content: string, tags: string[] = []) {
  const published = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published, updated_at)
       VALUES (?, 'Note', ?, ?, 'public', 1, '{}', ?, ?)`
    )
    .bind(id, actorId, content, published, published)
    .run();
  for (const tag of tags) {
    await db
      .prepare("INSERT INTO object_tags (object_id, tag, published, actor_id) VALUES (?, ?, ?, ?)")
      .bind(id, tag, published, actorId)
      .run();
  }
}

async function run(q: string, type = "all"): Promise<Results> {
  const res = await search(
    new NextRequest(`${BASE}/api/v2/search?q=${encodeURIComponent(q)}&type=${type}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Results;
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedActor(ME);
  await db
    .prepare("INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))")
    .bind("t1", ME, TOKEN)
    .run();
});

/**
 * Both searches used to be full scans: `tag LIKE '%q%'` walked the whole
 * 90-day window of a 1.2M-row `object_tags` (839,376 rows / 4 s per debounced
 * keystroke, anonymously reachable) and the status search joined `actors`
 * INSIDE the content scan (1,420,039 rows / 41 s for one query) — either one
 * trips D1's 10-second resource window and 500s the search.
 */
describe("search cost guards", () => {
  it("matches hashtags by prefix, not by substring", async () => {
    await seedObject(`${BASE}/objects/1`, ME, "<p>#panorama #japan</p>", ["pan", "panorama", "japan"]);

    const tags = (await run("pan", "hashtags")).hashtags.map((h) => h.name);
    expect(tags.sort()).toEqual(["pan", "panorama"]);
    expect(tags).not.toContain("japan");
    // A bare '#' has no prefix to match: no scan, no results.
    expect((await run("#", "hashtags")).hashtags).toEqual([]);
  });

  it("filters suspended and silenced authors without joining inside the scan", async () => {
    const banned = `${BASE}/users/banned`;
    const limited = `${BASE}/users/limited`;
    await seedActor(banned, { suspended: true });
    await seedActor(limited, { silenced: true });
    await seedObject(`${BASE}/objects/ok`, ME, "<p>bread recipe</p>");
    await seedObject(`${BASE}/objects/sus`, banned, "<p>bread spam</p>");
    await seedObject(`${BASE}/objects/sil`, limited, "<p>bread noise</p>");

    const found = await run("bread", "statuses");
    // Local statuses serialize with their short id (the object's last segment).
    expect(found.statuses.map((s) => s.id)).toEqual(["ok"]);
  });

  it("skips the content scan for queries under three characters", async () => {
    await seedObject(`${BASE}/objects/1`, ME, "<p>hi there</p>");
    expect((await run("hi", "statuses")).statuses).toEqual([]);
    expect((await run("there", "statuses")).statuses).toHaveLength(1);
  });
});
