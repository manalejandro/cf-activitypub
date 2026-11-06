import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as TRENDS_TAGS } from "@/app/api/v1/trends/tags/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example.test";

type TrendTag = { name: string; history: { uses: string; accounts: string }[] };

async function seedActor(username: string): Promise<string> {
  const id = `${BASE}/users/${username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, 'user', ?, 1)`
    )
    .bind(id, username, `${username}@example.test`)
    .run();
  return id;
}

let objectSeq = 0;

/** One object + its tag row (`object_tags.object_id` is a FK to `objects`). */
async function seedTagged(tag: string, actorId: string, daysAgo = 0): Promise<void> {
  const id = `${BASE}/objects/o${objectSeq++}`;
  const published = new Date(Date.now() - daysAgo * 86400000).toISOString();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, published, updated_at)
       VALUES (?, 'Note', ?, '<p>x</p>', 'public', 1, ?, ?)`
    )
    .bind(id, actorId, published, published)
    .run();
  await db
    .prepare("INSERT INTO object_tags (object_id, tag, published, actor_id) VALUES (?, ?, ?, ?)")
    .bind(id, tag, published, actorId)
    .run();
}

async function getTrends(limit = 10): Promise<TrendTag[]> {
  const res = await TRENDS_TAGS(new NextRequest(`${BASE}/api/v1/trends/tags?limit=${limit}`));
  expect(res.status).toBe(200);
  return (await res.json()) as TrendTag[];
}

beforeEach(async () => {
  await resetTestStorage();
  objectSeq = 0;
});

/**
 * The ranking is computed in two phases (volume through the published-led
 * index, then exact `COUNT(DISTINCT actor_id)` for just the winning tags):
 * one query over the whole tag table cost 4.7 s / 873k rows on cf-ap because
 * the planner preferred the tag-led covering index and scanned every row.
 * These pin that the split keeps the response exact.
 */
describe("trending tags", () => {
  it("ranks by in-window volume with exact distinct-account counts", async () => {
    const a1 = await seedActor("one");
    const a2 = await seedActor("two");
    const a3 = await seedActor("three");

    await seedTagged("solo", a1);
    await seedTagged("solo", a1);
    await seedTagged("solo", a1);
    await seedTagged("solo", a1);
    await seedTagged("alpha", a1);
    await seedTagged("alpha", a2);
    await seedTagged("alpha", a2);
    await seedTagged("beta", a1);
    await seedTagged("beta", a3);
    // Out of the 7-day window: it must not rank, however popular it was.
    for (let i = 0; i < 6; i++) await seedTagged("ancient", a2, 8);

    const tags = await getTrends();
    expect(tags.map((t) => t.name)).toEqual(["solo", "alpha", "beta"]);
    expect(tags[0].history[0]).toMatchObject({ uses: "4", accounts: "1" });
    expect(tags[1].history[0]).toMatchObject({ uses: "3", accounts: "2" });
    expect(tags[2].history[0]).toMatchObject({ uses: "2", accounts: "2" });
  });

  it("honours the clamped limit in both phases", async () => {
    const a1 = await seedActor("one");
    for (const tag of ["t1", "t2", "t3"]) {
      await seedTagged(tag, a1);
      await seedTagged(tag, a1);
    }
    await seedTagged("t1", a1);
    await seedTagged("t1", a1);
    await seedTagged("t2", a1);

    const tags = await getTrends(2);
    expect(tags).toHaveLength(2);
    expect(tags.map((t) => t.name)).toEqual(["t1", "t2"]);
    expect(tags[0].history[0]).toMatchObject({ uses: "4", accounts: "1" });
    expect(tags[1].history[0]).toMatchObject({ uses: "3", accounts: "1" });
  });

  it("serves the ranking from KV, so a miss is the only expensive call", async () => {
    const a1 = await seedActor("one");
    await seedTagged("cached", a1);
    expect((await getTrends()).map((t) => t.name)).toEqual(["cached"]);

    // The stored payload answers even after the rows are gone: proof the second
    // call never touched the DB (and that the TTL, not a recompute, refreshes).
    await db.prepare("DELETE FROM object_tags").run();
    expect((await getTrends()).map((t) => t.name)).toEqual(["cached"]);
  });
});
