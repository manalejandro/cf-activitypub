import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { clampLimit, resolveLimits } from "@/lib/constants";
import { serializeTag } from "@/lib/mastodon/tags";
import { env } from "cloudflare:workers";

// GET /api/v1/trends/tags
// Returns trending hashtags from the last 7 days.
export async function GET(request: NextRequest): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const limit = clampLimit(
    request.nextUrl.searchParams.get("limit"),
    limits.trendingTagsLimit,
    limits.trendingTagsMax
  );

  // The result is identical for every client, so the 7-day aggregation is
  // computed once and served from KV — the DB query only runs on a cache miss.
  const cacheKey = "trends:tags:v1";
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  } catch { /* fall through to recompute */ }

  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString();

  // Two phases, because a single aggregation over the tag table is the most
  // expensive read in the app: measured on cf-ap (1.2M rows) it cost 4,694 ms
  // and 873,159 rows read — the planner takes the tag-led COVERING index and
  // scans the whole table to get the GROUP BY for free, ignoring the 7-day
  // window, and the per-group COUNT(DISTINCT) adds a second temp b-tree.
  //
  //  1. Rank by volume through the published-led index, so only the window is
  //     read and the grouping is one plain temp b-tree (284 ms / 378k rows).
  //  2. Exact distinct-account counts for just those tags (≤ trendingTagsMax
  //     = 20 binds), each a tight (tag, published) range on the tag-led
  //     covering index (120 ms / 24k rows).
  //
  // Together 404 ms / 402k rows for a byte-identical response.
  const ranked = await env.DB
    .prepare(
      `SELECT tag, COUNT(*) AS uses
       FROM object_tags INDEXED BY idx_object_tags_pub_tag_actor
       WHERE published >= ?
       GROUP BY tag
       ORDER BY uses DESC
       LIMIT ?`
    )
    .bind(weekCutoff, limit)
    .all<{ tag: string; uses: number }>();

  const top = ranked.results ?? [];
  const actorsByTag = new Map<string, number>();
  if (top.length > 0) {
    const placeholders = top.map(() => "?").join(", ");
    const counts = await env.DB
      .prepare(
        `SELECT tag, COUNT(DISTINCT actor_id) AS actors
         FROM object_tags INDEXED BY idx_object_tags_tag_pub_actor
         WHERE published >= ? AND tag IN (${placeholders})
         GROUP BY tag`
      )
      .bind(weekCutoff, ...top.map((r) => r.tag))
      .all<{ tag: string; actors: number }>();
    for (const row of counts.results ?? []) actorsByTag.set(row.tag, Number(row.actors));
  }

  const sorted = top.map((r) =>
    serializeTag(r.tag, domain, Number(r.uses), actorsByTag.get(r.tag) ?? 0)
  );

  const body = json(sorted);
  // A 7-day ranking does not move in 5 minutes: Mastodon recomputes its trends
  // hourly, and every cache miss used to put a multi-second aggregation in
  // front of a user request (288 of them a day at the old TTL).
  await env.KV.put(cacheKey, JSON.stringify(sorted), { expirationTtl: 3600 }).catch(() => {});
  return body;
}
