import { type NextRequest } from "next/server";
import { json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { normalizeLicenseId } from "@/lib/licenses";
import { SUPPORTED_LANGUAGE_CODES } from "@/lib/locales/supported";
import { env } from "cloudflare:workers";

const DEFAULT_PREFERENCES: Record<string, string | null> = {
  "posting:default:visibility": "public",
  "posting:default:sensitive": "false",
  "posting:default:language": "en",
  "posting:default:quote_policy": "followers",
  // FEP-6757: catalogue id of the license new statuses default to ("" = none).
  "posting:default:license": "",
  "reading:expand:media": "default",
  "reading:expand:spoilers": "false",
  "ui:locale": "en",
  // ── Calls ─────────────────────────────────────────────────────────────────
  // Who may ring this account: nobody, only accounts that asked first, everyone.
  "calls:policy": "nobody",
  // Media the caller is allowed to use. Enforced when the call starts.
  "calls:allow_audio": "true",
  "calls:allow_video": "true",
  "calls:allow_screen": "true",
  // Playback volume of the remote peer during a call (0-100).
  "calls:volume": "100",
};

const PREFERENCE_KEYS = new Set(Object.keys(DEFAULT_PREFERENCES));

const BOOLEAN_PREFERENCES = new Set([
  "posting:default:sensitive",
  "reading:expand:spoilers",
  "calls:allow_audio",
  "calls:allow_video",
  "calls:allow_screen",
]);

const VISIBILITIES = new Set(["public", "unlisted", "private", "direct"]);
const QUOTE_POLICIES = new Set(["public", "followers", "followed", "nobody"]);
const MEDIA_EXPANSIONS = new Set(["default", "show_all", "hide_all"]);
const CALL_POLICIES = new Set(["nobody", "request", "everyone"]);
// Supported UI locales come from lib/locales/supported (the same source the
// instance API endpoints use).
const LOCALES = new Set(SUPPORTED_LANGUAGE_CODES);

// Validates and coerces a preference value into its storage (string) form.
function normalizeValue(key: string, raw: unknown): string | null | undefined {
  if (BOOLEAN_PREFERENCES.has(key)) {
    return typeof raw === "boolean" ? String(raw) : undefined;
  }
  if (key === "calls:volume") {
    // Accepts a number or a numeric string (clients disagree on the shape) and
    // stores it as an integer percentage so the value round-trips unchanged.
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
    return String(Math.round(n));
  }
  if (key === "posting:default:language") {
    if (raw === null) return null;
    if (typeof raw === "string" && /^[a-z]{2}$/.test(raw)) return raw;
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  switch (key) {
    case "calls:policy":
      return CALL_POLICIES.has(raw) ? raw : undefined;
    case "posting:default:license":
      // Empty clears the preference (no license); otherwise it must look like a
      // catalogue id. Unknown ids are ignored by the composers.
      if (raw === "") return "";
      return normalizeLicenseId(raw) ?? undefined;
    case "posting:default:visibility":
      return VISIBILITIES.has(raw) ? raw : undefined;
    case "posting:default:quote_policy":
      return QUOTE_POLICIES.has(raw) ? raw : undefined;
    case "reading:expand:media":
      return MEDIA_EXPANSIONS.has(raw) ? raw : undefined;
    case "ui:locale":
      return LOCALES.has(raw) ? raw : undefined;
    default:
      return undefined;
  }
}

// Converts stored string values into the JSON shape the API returns.
function toApiValue(key: string, stored: string | null): string | number | boolean | null {
  if (BOOLEAN_PREFERENCES.has(key)) {
    return stored === "true";
  }
  if (key === "calls:volume") {
    const n = stored === null ? NaN : Number(stored);
    return Number.isFinite(n) ? n : Number(DEFAULT_PREFERENCES[key] ?? 100);
  }
  return stored;
}

export async function GET(request: NextRequest): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rows = await env.DB
    .prepare("SELECT key, value FROM preferences WHERE actor_id = ?")
    .bind(actor.id)
    .all<{ key: string; value: string }>();

  const stored = new Map(rows.results?.map((r) => [r.key, r.value]) ?? []);
  const prefs: Record<string, string | number | boolean | null> = {};
  for (const key of PREFERENCE_KEYS) {
    prefs[key] = toApiValue(key, stored.has(key) ? stored.get(key)! : DEFAULT_PREFERENCES[key]);
  }
  return json(prefs);
}

export async function PUT(request: NextRequest): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const updates: { key: string; value: string | null }[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!PREFERENCE_KEYS.has(key)) continue;
    const value = normalizeValue(key, raw);
    if (value === undefined) return badRequest(`Invalid value for "${key}"`);
    updates.push({ key, value });
  }

  if (updates.length > 0) {
    await env.DB.batch(updates.map((u) =>
      env.DB
        .prepare(
          "INSERT INTO preferences (actor_id, key, value) VALUES (?, ?, ?) ON CONFLICT (actor_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
        )
        .bind(actor.id, u.key, u.value)
    ));
  }

  const rows = await env.DB
    .prepare("SELECT key, value FROM preferences WHERE actor_id = ?")
    .bind(actor.id)
    .all<{ key: string; value: string }>();

  const stored = new Map(rows.results?.map((r) => [r.key, r.value]) ?? []);
  const prefs: Record<string, string | number | boolean | null> = {};
  for (const key of PREFERENCE_KEYS) {
    prefs[key] = toApiValue(key, stored.has(key) ? stored.get(key)! : DEFAULT_PREFERENCES[key]);
  }
  return json(prefs);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return PUT(request);
}