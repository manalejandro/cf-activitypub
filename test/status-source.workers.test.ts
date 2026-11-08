import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { GET as getSource } from "@/app/api/v1/statuses/[id]/source/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example.test";
const ACTOR = `${BASE}/users/author`;
const OBJECT = `${BASE}/objects/src-1`;

beforeEach(async () => {
  await resetTestDatabase();
});

/**
 * The edit composer starts from this text, so everything the rendered HTML only
 * keeps in an attribute must survive it. A bare tag strip lost the domain of a
 * remote mention (it lives in the anchor's `title`, the visible text is
 * `@maripile`), every custom emoji (an `<img alt=":code:">`) and the line
 * breaks — so saving an edit re-rendered the mention as plain text and its link
 * disappeared.
 */
describe("GET /api/v1/statuses/:id/source", () => {
  it("recovers mentions, emoji and line breaks from the rendered HTML", async () => {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
         VALUES (?, 'author', 'local.example.test', 'pub', 'priv', 1)`
      )
      .bind(ACTOR)
      .run();
    const content =
      `<p><a href="https://tuiter.rocks/users/Maripili" class="u-url mention" rel="nofollow noopener noreferrer" ` +
      `title="@maripile@tuiter.rocks">@<span>maripile</span></a> tarda casi 3h<br>segunda línea ` +
      `<img src="https://cdn.example/e.png" alt=":blob:" class="emojione custom-emoji" rel="emoji" title=":blob:" width="16" height="16" /> ` +
      `y <a href="https://ejemplo.example/ruta" target="_blank" rel="nofollow noopener noreferrer">https://ejemplo.example/ruta</a> &amp; listo</p>`;
    const published = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published, updated_at)
         VALUES (?, 'Note', ?, ?, 'public', 1, '{}', ?, ?)`
      )
      .bind(OBJECT, ACTOR, content, published, published)
      .run();

    const res = await getSource(
      new NextRequest(`${BASE}/api/v1/statuses/${encodeURIComponent(OBJECT)}/source`),
      { params: Promise.resolve({ id: OBJECT }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };

    expect(body.text).toContain("@maripile@tuiter.rocks");
    expect(body.text).toContain(":blob:");
    expect(body.text).toContain("segunda línea");
    expect(body.text).toContain("https://ejemplo.example/ruta");
    expect(body.text).toContain("& listo");
    expect(body.text).not.toContain("<");
    expect(body.text).not.toContain("<br>");
    // The line break survives as a real newline, so the edit is not one line.
    expect(body.text.split("\n").length).toBeGreaterThan(1);
  });
});
