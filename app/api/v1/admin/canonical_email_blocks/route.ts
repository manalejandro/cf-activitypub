import { type NextRequest } from "next/server";
import { json, badRequest } from "@/lib/cf";
import { getAdminRole } from "@/lib/admin-auth";
import {
  createCanonicalEmailBlock,
  deleteCanonicalEmailBlock,
  listCanonicalEmailBlocks,
} from "@/lib/db";
import { canonicalEmail, canonicalEmailHash } from "@/lib/canonical-email";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { env } from "cloudflare:workers";

// GET /api/v1/admin/canonical_email_blocks — mailboxes that cannot register.
export async function GET(request: NextRequest): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }
  const blocks = await listCanonicalEmailBlocks(env.DB);
  return json(
    blocks.map((b) => ({
      hash: b.hash,
      reference_email: b.referenceEmail,
      reason: b.reason,
      created_at: b.createdAt,
    }))
  );
}

// POST /api/v1/admin/canonical_email_blocks — block a mailbox (any variant).
// body: { email, reason? }
export async function POST(request: NextRequest): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  let body: { email?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; reason?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return badRequest("email is required");
  const hash = await canonicalEmailHash(email);

  await createCanonicalEmailBlock(
    env.DB,
    hash,
    canonicalEmail(email),
    typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Blocked by an administrator"
  );

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "email",
    targetId: hash.slice(0, 12),
    action: "blocked",
    reason: "Mailbox blocked by an administrator.",
    confidence: null,
    model: "admin",
    details: { email: canonicalEmail(email), hash },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ ok: true, hash });
}

// DELETE /api/v1/admin/canonical_email_blocks?hash=… — unblock a mailbox.
export async function DELETE(request: NextRequest): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }
  const hash = request.nextUrl.searchParams.get("hash")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return badRequest("hash is required");

  const removed = await deleteCanonicalEmailBlock(env.DB, hash);
  if (!removed) return json({ ok: false, error: "Not found" }, 404);

  // The attempt counter lives in KV (`canonical:reg:<hash>`, 24 h TTL). Clearing
  // only the row would leave the mailbox refused — the third attempt sees
  // `priorAttempts >= 2` and re-creates the block — so an administrator's
  // "unblock" would appear to do nothing for up to a day.
  try {
    await env.KV.delete(`canonical:reg:${hash}`);
  } catch { /* best effort: the TTL clears it within a day anyway */ }

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "email",
    targetId: hash.slice(0, 12),
    action: "unblocked",
    reason: "Mailbox unblocked by an administrator.",
    confidence: null,
    model: "admin",
    details: { hash },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ ok: true });
}
