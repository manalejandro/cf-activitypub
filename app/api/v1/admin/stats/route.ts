// Instance statistics for the admin panel: the same public status (components
// plus counters) and the operator's view on top — database size and row counts,
// storage retention, the federation registry, delivery failures, the media
// cache with its effective limits, moderation counters, the cron's last run and
// which optional features are configured. Computed per request: an operator
// opening the panel wants today's numbers, not a minute-old copy. The single
// exception is the row-count block — ten full-table COUNT(*), ~1.7M rows and
// ~4 s on cf-ap — which is KV-cached for 5 minutes; `?fresh=1` (the panel's
// refresh button) remeasures it on demand.
import { type NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getInstanceStatsSnapshot } from "@/lib/instance-stats";

// GET /api/v1/admin/stats
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const freshRowCounts = request.nextUrl.searchParams.get("fresh") === "1";
  const snapshot = await getInstanceStatsSnapshot(env, Date.now(), { freshRowCounts });
  return json(snapshot);
}
