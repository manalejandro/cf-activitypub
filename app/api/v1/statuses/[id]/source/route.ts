import { type NextRequest } from "next/server";
import { getInstanceTitle, json, notFound } from "@/lib/cf";
import { getObjectById, isAcceptedFollower, canViewStatus } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { emojiImgsToShortcodes, statusHtmlToPlain } from "@/lib/activitypub/content";
import { env } from "cloudflare:workers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const domain = new URL(_request.url).hostname;
  const rawId = (await params).id;
  const id = decodeStatusId(rawId, domain);
  const obj = await getObjectById(env.DB, id);
  if (!obj) return notFound();
  const me = await getAuthenticatedActor(_request, env.DB);
  const isFollowing = me ? await isAcceptedFollower(env.DB, me.id, obj.actorId) : false;
  if (!canViewStatus(obj, me?.id ?? null, isFollowing)) return notFound();
  // The composer needs the SOURCE text, not the rendered HTML with its tags
  // deleted. A bare strip loses everything that only survives in an attribute:
  // a remote mention renders as `@maripile` with the full handle in the
  // anchor's `title` (so an edit re-rendered it as plain text and the link
  // disappeared), custom emoji live in an `<img alt=":code:">`, and `<br>`/
  // `</p>` are the line breaks. `statusHtmlToPlain` recovers all three; emoji
  // go back to shortcodes first. (Kept out of the literal below: a comment
  // inside it stops the OpenAPI generator's property inference at that point.)
  const text = statusHtmlToPlain(emojiImgsToShortcodes(obj.content ?? ""));
  return json({
    id,
    text,
    content_warning: obj.contentWarning ?? null,
    language: obj.language ?? null,
    poll: null,
    media_attachments: [],
    sensitive: obj.sensitive,
    spoiler_text: obj.contentWarning ?? null,
    created_at: obj.published,
    updated_at: obj.updatedAt ?? obj.published,
    application: obj.local ? { name: getInstanceTitle(), website: null } : null,
  });
}
