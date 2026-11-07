import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import { loadSerializedPolls } from "@/lib/mastodon/serializers";
import { createPoll, createPollVotes, getPollById, getPollOptions, listPollsToNotify, listRemotePollsForRefresh } from "@/lib/db";
import { applyPollToNoteFromDb, refreshPollFromQuestion } from "@/lib/activitypub/polls";
import { getQuotesByIds } from "@/lib/mastodon/quote";
import { buildNote } from "@/lib/activitypub/utils";
import { GET as getObjectRoute } from "@/app/objects/[id]/route";
import { resetTestStorage } from "./helpers/db";

const db = env.DB;

beforeEach(async () => {
  await resetTestDatabase();
});

describe("loadSerializedPolls", () => {
  it("marks a poll as voted for the viewer who voted and leaves others untouched", async () => {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/1', 'Note', 'https://local.example/users/me', 'q', 'public', 1, '{}')`
    ).bind().run();
    await db.prepare(
      "INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES ('p1', 'https://local.example/objects/1', ?, 0, 1, 1)"
    ).bind(new Date(Date.now() + 60_000).toISOString()).run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o1','p1','A',1,0)").bind().run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o2','p1','B',0,1)").bind().run();
    await db.prepare(
      "INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES ('v1','p1','https://local.example/users/me',0)"
    ).bind().run();

    const map = await loadSerializedPolls(db, "https://local.example/users/me", ["https://local.example/objects/1"]);
    const poll = map.get("https://local.example/objects/1");
    expect(poll?.voted).toBe(true);
    expect(poll?.own_votes).toEqual([0]);

    const anonymous = await loadSerializedPolls(db, null, ["https://local.example/objects/1"]);
    expect(anonymous.get("https://local.example/objects/1")?.voted).toBe(false);
    expect(anonymous.get("https://local.example/objects/1")?.own_votes).toEqual([]);
  });
});

describe("outbound poll serialization (applyPollToNote)", () => {
  const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

  beforeEach(async () => {
    await resetTestStorage();
  });

  async function seedLocalPoll(multiple = false): Promise<void> {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/q1', 'Note', 'https://local.example/users/me', '¿A o B?', 'public', 1, '{}')`
    ).bind().run();
    await createPoll(db, {
      id: "p-local",
      objectId: "https://local.example/objects/q1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple,
      options: [
        { id: "lo1", title: "A", position: 0 },
        { id: "lo2", title: "B", position: 1 },
      ],
    });
    await db.prepare("UPDATE poll_options SET votes_count = 3 WHERE id = 'lo1'").bind().run();
    await db.prepare("UPDATE poll_options SET votes_count = 1 WHERE id = 'lo2'").bind().run();
    await db.prepare("UPDATE polls SET voters_count = 4 WHERE id = 'p-local'").bind().run();
  }

  function localNote() {
    return buildNote("https://local.example", "q1", {
      actorUsername: "me",
      content: "¿A o B?",
      published: "2026-01-01T00:00:00Z",
      visibility: "public",
    });
  }

  it("renders the choices with their counts, the deadline and the voters", async () => {
    await seedLocalPoll();
    const note = localNote();
    await applyPollToNoteFromDb(db, note);
    const ap = note as Record<string, unknown>;

    expect(ap.type).toBe("Question");
    expect(ap.oneOf).toEqual([
      { type: "Note", name: "A", replies: { type: "Collection", totalItems: 3 } },
      { type: "Note", name: "B", replies: { type: "Collection", totalItems: 1 } },
    ]);
    expect(ap.anyOf).toBeUndefined();
    expect(ap.votersCount).toBe(4);
    expect(typeof ap.endTime).toBe("string");
    expect(ap.closed).toBeUndefined();
  });

  it("uses anyOf for a multiple-choice poll and marks an expired one closed", async () => {
    await seedLocalPoll(true);
    await db.prepare("UPDATE polls SET expires_at = ? WHERE id = 'p-local'")
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();

    const note = localNote();
    await applyPollToNoteFromDb(db, note);
    const ap = note as Record<string, unknown>;

    expect(ap.anyOf).toBeDefined();
    expect(ap.oneOf).toBeUndefined();
    expect(typeof ap.closed).toBe("string");
  });

  it("leaves a note without a poll untouched", async () => {
    const note = localNote();
    await applyPollToNoteFromDb(db, note);
    expect((note as Record<string, unknown>).type).toBe("Note");
    expect((note as Record<string, unknown>).oneOf).toBeUndefined();
  });

  it("serves a poll status as a Question on the object endpoint", async () => {
    await seedLocalPoll();
    const request = new Request("https://local.example/objects/q1", {
      headers: { accept: "application/activity+json" },
    });
    const response = await getObjectRoute(request as never, { params: Promise.resolve({ id: "q1" }) });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.type).toBe("Question");
    expect(body.oneOf).toEqual([
      { type: "Note", name: "A", replies: { type: "Collection", totalItems: 3 } },
      { type: "Note", name: "B", replies: { type: "Collection", totalItems: 1 } },
    ]);
    expect(body.interactionPolicy).toEqual({ canQuote: { automaticApproval: [PUBLIC] } });
  });
});

describe("refreshPollFromQuestion", () => {
  async function seedRemotePoll(db: D1Database): Promise<void> {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://remote.example/users/author', 'author', 'remote.example', 'k', NULL, 0)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://remote.example/objects/q1', 'Question', 'https://remote.example/users/author', 'poll', 'public', 0, '{}')`
    ).bind().run();
    await createPoll(db, {
      id: "p-remote",
      objectId: "https://remote.example/objects/q1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple: false,
      options: [
        { id: "ro1", title: "A", position: 0 },
        { id: "ro2", title: "B", position: 1 },
      ],
    });
  }

  it("applies the origin's per-choice counts and totals without touching local votes", async () => {
    await seedRemotePoll(db);
    // A local vote already recorded (must survive the refresh).
    await db.prepare(
      "INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES ('lv','p-remote','https://remote.example/users/author',0)"
    ).bind().run();

    const ok = await refreshPollFromQuestion(db, {
      id: "https://remote.example/objects/q1",
      type: "Question",
      oneOf: [
        { name: "A", replies: { totalItems: 7 } },
        { name: "B", replies: { totalItems: 3 } },
      ],
      votersCount: 9,
    });
    expect(ok).toBe(true);

    const options = await getPollOptions(db, "p-remote");
    expect(options.map((o) => o.votesCount)).toEqual([7, 3]);
    const poll = await getPollById(db, "p-remote");
    expect(poll?.votesCount).toBe(10);
    expect(poll?.votersCount).toBe(9);
    const localVotes = await db.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = 'p-remote'").bind().first<{ n: number }>();
    expect(localVotes?.n).toBe(1);
  });

  it("ignores a partial document instead of clobbering the counts", async () => {
    await seedRemotePoll(db);

    const ok = await refreshPollFromQuestion(db, {
      id: "https://remote.example/objects/q1",
      type: "Question",
      oneOf: [{ name: "A", replies: { totalItems: 5 } }],
    });
    expect(ok).toBe(false);
    const options = await getPollOptions(db, "p-remote");
    expect(options.map((o) => o.votesCount)).toEqual([0, 0]);
  });

  it("skips the rewrite when the counts did not change (D1 write quota)", async () => {
    await seedRemotePoll(db);
    const question = {
      id: "https://remote.example/objects/q1",
      type: "Question",
      oneOf: [
        { name: "A", replies: { totalItems: 4 } },
        { name: "B", replies: { totalItems: 2 } },
      ],
      votersCount: 6,
    };
    // The refresh cron re-reads every live remote poll every few minutes: an
    // identical document must not rewrite the option rows + poll row each
    // time (tens of thousands of rows a day on a relay-fed instance).
    let batchCalls = 0;
    const countingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (stmts: unknown[]) => { batchCalls++; return db.batch(stmts as never); },
    } as never;

    expect(await refreshPollFromQuestion(countingDb, question)).toBe(true);
    expect(batchCalls).toBe(1); // first refresh applies the new counts

    expect(await refreshPollFromQuestion(countingDb, question)).toBe(true);
    expect(batchCalls).toBe(1); // unchanged → no write

    // A real change still lands immediately.
    const changed = {
      ...question,
      oneOf: [
        { name: "A", replies: { totalItems: 5 } },
        { name: "B", replies: { totalItems: 2 } },
      ],
    };
    expect(await refreshPollFromQuestion(countingDb, changed)).toBe(true);
    expect(batchCalls).toBe(2);
    const options = await getPollOptions(db, "p-remote");
    expect(options.map((o) => o.votesCount)).toEqual([5, 2]);
  });
});

describe("createPollVotes", () => {
  it("counts one voter for a multiple-choice vote (votes_count per choice)", async () => {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/q2', 'Question', 'https://local.example/users/me', 'poll', 'public', 1, '{}')`
    ).bind().run();
    await createPoll(db, {
      id: "p-multi",
      objectId: "https://local.example/objects/q2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple: true,
      options: [
        { id: "mo1", title: "A", position: 0 },
        { id: "mo2", title: "B", position: 1 },
      ],
    });

    await createPollVotes(db, "p-multi", "https://local.example/users/me", [0, 1]);
    const poll = await getPollById(db, "p-multi");
    expect(poll?.votesCount).toBe(2);
    expect(poll?.votersCount).toBe(1);
    const options = await getPollOptions(db, "p-multi");
    expect(options.map((o) => o.votesCount)).toEqual([1, 1]);
  });
});

describe("listRemotePollsForRefresh", () => {
  it("selects only active remote polls from recent statuses", async () => {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://remote.example/users/author', 'author', 'remote.example', 'k', NULL, 0)`
    ).bind().run();
    const insertObject = async (id: string, isLocal: number, published: string) => {
      await db.prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published)
         VALUES (?, 'Question', 'https://remote.example/users/author', 'poll', 'public', ?, '{}', ?)`
      ).bind(id, isLocal, published).run();
    };
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    await insertObject("https://remote.example/objects/fresh", 0, iso(0));
    await insertObject("https://remote.example/objects/old", 0, iso(-30 * 86400000));
    await insertObject("https://remote.example/objects/local", 1, iso(0));
    for (const [id, objectId, expires] of [
      ["p-fresh", "https://remote.example/objects/fresh", iso(3600_000)],
      ["p-old", "https://remote.example/objects/old", iso(3600_000)],
      ["p-local", "https://remote.example/objects/local", iso(3600_000)],
      ["p-expired", "https://remote.example/objects/fresh", iso(-1000)],
    ]) {
      await db.prepare(
        "INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES (?,?,?,0,0,0)"
      ).bind(id, objectId, expires).run();
    }

    const due = await listRemotePollsForRefresh(db, 10);
    expect(due.map((p) => p.id)).toEqual(["p-fresh"]);
  });

  /**
   * Plan pin (mirrors `listRemotePollsForRefresh` — update both together).
   * Without `INDEXED BY` + `CROSS JOIN` the planner drives from `objects` on
   * `is_local = 0` and walks every remote object probing for a live poll:
   * 7,164 ms / 59,014 rows per call against 11 ms / 99 rows on cf-ap.
   */
  it("drives from the live polls instead of scanning every remote object", async () => {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT p.id, p.object_id
         FROM polls p INDEXED BY idx_polls_expires
         CROSS JOIN objects o ON o.id = p.object_id
         WHERE p.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           AND o.is_local = 0
           AND o.published >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
         ORDER BY o.published DESC LIMIT 10`
      )
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail);
    expect(details[0]).toContain("idx_polls_expires");
    expect(details[1]).toContain("sqlite_autoindex_objects_1");
    expect(details.join(" ")).not.toContain("idx_objects_local_pub_actor");
  });
});

describe("getQuotesByIds (quoted polls)", () => {
  it("includes the quoted poll with the viewer's own votes", async () => {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).run();
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local)
       VALUES ('https://remote.example/users/author', 'author', 'remote.example', 'k', 0)`
    ).run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://remote.example/objects/q9', 'Question', 'https://remote.example/users/author', '<p>encuesta</p>', 'public', 0, '{}')`
    ).run();
    await createPoll(db, {
      id: "pq9",
      objectId: "https://remote.example/objects/q9",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      multiple: false,
      options: [
        { id: "o1", title: "A", position: 0 },
        { id: "o2", title: "B", position: 1 },
      ],
    });
    await createPollVotes(db, "pq9", "https://local.example/users/me", [0]);

    const map = await getQuotesByIds(
      db,
      ["https://remote.example/objects/q9"],
      "local.example",
      "https://local.example/users/me"
    );
    const quoted = map.get("https://remote.example/objects/q9");
    expect(quoted?.poll).not.toBeNull();
    expect(quoted?.poll?.options.map((o) => o.title)).toEqual(["A", "B"]);
    expect(quoted?.poll?.voted).toBe(true);
    expect(quoted?.poll?.own_votes).toEqual([0]);
  });
});

describe("listPollsToNotify", () => {
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const AUTHOR = "https://remote.example/users/pollauthor";
  const VOTER = "https://remote.example/users/voter";

  async function seedActor(id: string) {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
         VALUES (?, ?, ?, 'k', NULL, 0)`
      )
      .bind(id, id.split("/").pop()!, new URL(id).hostname)
      .run();
  }

  async function seedPoll(pollId: string, objectId: string, expiresAt: string, publishedMs: number) {
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published)
         VALUES (?, 'Question', ?, 'poll', 'public', 0, '{}', ?)`
      )
      .bind(objectId, AUTHOR, iso(publishedMs))
      .run();
    await db
      .prepare("INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES (?,?,?,0,0,0)")
      .bind(pollId, objectId, expiresAt)
      .run();
  }

  it("returns expired polls whose author was not notified yet, and only those", async () => {
    await seedActor(AUTHOR);
    await seedActor(VOTER);
    await seedPoll("p-due", "https://remote.example/objects/due", iso(-3600_000), -2 * 3600_000);
    await seedPoll("p-done", "https://remote.example/objects/done", iso(-3600_000), -2 * 3600_000);
    // The notification row IS the idempotency marker.
    await db
      .prepare(
        `INSERT INTO notifications (id, type, account_id, target_account_id, object_id)
         VALUES ('n1', 'poll', ?, ?, 'https://remote.example/objects/done')`
      )
      .bind(AUTHOR, VOTER)
      .run();
    await seedPoll("p-live", "https://remote.example/objects/live", iso(3600_000), 0);
    await seedPoll("p-ancient", "https://remote.example/objects/ancient", iso(-8 * 86400_000), -9 * 86400_000);

    const due = await listPollsToNotify(db, 20);
    expect(due.map((p) => p.pollId)).toEqual(["p-due"]);
    expect(due[0]).toMatchObject({ objectId: "https://remote.example/objects/due", actorId: AUTHOR });
  });

  /**
   * Plan pin (mirrors `listPollsToNotify` — update both together). With
   * `datetime()` around the columns the expiry range became a full index scan,
   * and the marker probe on `idx_notif_dedup (type, account_id, …)` walked every
   * poll notification of the author: 182,390 rows per call, every 3 minutes.
   */
  it("ranges the polls by expiry and probes the marker by object_id", async () => {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT p.id FROM polls p JOIN objects o ON o.id = p.object_id
         WHERE p.expires_at IS NOT NULL
           AND p.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
           AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
           AND NOT EXISTS (
             SELECT 1 FROM notifications n INDEXED BY idx_notifications_object
             WHERE n.object_id = o.id AND n.type = 'poll' AND n.account_id = o.actor_id
           )
         ORDER BY p.expires_at ASC LIMIT 20`
      )
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    expect(details).toContain("idx_polls_expires (expires_at>? AND expires_at<?)");
    expect(details).toContain("idx_notifications_object (object_id=?)");
    expect(details).not.toContain("SCAN p");
  });
});
