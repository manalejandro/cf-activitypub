import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import { getPublicTimeline } from "@/lib/db";

const db = env.DB;

/** ISO-8601 with Z: the shape `objects.published` keeps (lib/dates.ts). */
function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

async function seedActor(id: string, isLocal: boolean) {
  const username = id.split("/").pop() ?? "u";
  const domain = isLocal ? "cf-ap.example" : "remote.example";
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, display_name, public_key_pem, private_key_pem, is_local,
         followers_count, following_count, statuses_count, suspended, created_at)
       VALUES (?, ?, ?, ?, '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', NULL, ?, 0, 0, 0, 0, datetime('now', '-30 days'))`
    )
    .bind(id, username, domain, username, isLocal ? 1 : 0)
    .run();
}

async function seed(id: string, isLocal: boolean, minutesAgo: number, visibility = "public") {
  const actorId = `https://${isLocal ? "cf-ap.example" : "remote.example"}/users/u`;
  const published = iso(minutesAgo);
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, published, updated_at)
       VALUES (?, 'Note', ?, '<p>x</p>', ?, ?, ?, ?)`
    )
    .bind(id, actorId, visibility, isLocal ? 1 : 0, published, published)
    .run();
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedActor("https://cf-ap.example/users/u", true);
  await seedActor("https://remote.example/users/u", false);
  // Remote (relay-fed) public statuses outnumber local ones, like production.
  for (let i = 0; i < 6; i++) await seed(`https://remote.example/objects/r${i}`, false, 10 + i);
  await seed("https://cf-ap.example/objects/l0", true, 12);
  await seed("https://cf-ap.example/objects/l1", true, 30);
  await seed("https://cf-ap.example/objects/l2", true, 60);
  await seed("https://cf-ap.example/objects/dm", true, 5, "direct");
});

describe("public timeline pagination (local/remote)", () => {
  it("keeps the local timeline local across every branch", async () => {
    const first = await getPublicTimeline(db, 20, undefined, true);
    expect(first.map((o) => o.id)).toEqual([
      "https://cf-ap.example/objects/l0",
      "https://cf-ap.example/objects/l1",
      "https://cf-ap.example/objects/l2",
    ]);

    // max_id: the branch whose second `published` range used to make the
    // planner drop `is_local` out of the index and walk every public object.
    const older = await getPublicTimeline(db, 20, "https://cf-ap.example/objects/l0", true);
    expect(older.map((o) => o.id)).toEqual([
      "https://cf-ap.example/objects/l1",
      "https://cf-ap.example/objects/l2",
    ]);

    // min_id / since_id walk the other direction from a bound pivot.
    const newer = await getPublicTimeline(db, 20, undefined, true, undefined, false, false, "https://cf-ap.example/objects/l2");
    expect(newer.map((o) => o.id)).toEqual([
      "https://cf-ap.example/objects/l0",
      "https://cf-ap.example/objects/l1",
    ]);

    const remote = await getPublicTimeline(db, 20, undefined, false, undefined, true);
    expect(remote.every((o) => o.id.startsWith("https://remote.example/"))).toBe(true);
    expect(remote).toHaveLength(6);
  });

  it("an unknown pivot returns an empty page instead of scanning", async () => {
    expect(await getPublicTimeline(db, 20, "https://cf-ap.example/objects/nope", true)).toEqual([]);
  });

  /**
   * The index the hint names must exist and stay usable: `INDEXED BY` on a
   * missing index is a hard error, and the local timeline's cost depends on it
   * (measured on cf-ap: 453,517 rows / 78 s per page without it, 74 rows / 9 ms
   * with it).
   */
  it("paginates the local timeline through idx_objects_vis_local_pub", async () => {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT o.* FROM objects o INDEXED BY idx_objects_vis_local_pub
         WHERE o.visibility = 'public' AND o.is_local = 1 AND o.published < ?
         ORDER BY o.published DESC LIMIT 20`
      )
      .bind(iso(0))
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("idx_objects_vis_local_pub");
  });
});
