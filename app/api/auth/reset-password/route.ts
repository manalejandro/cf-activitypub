import { type NextRequest } from "next/server";
import { json, checkRateLimit } from "@/lib/cf";
import { deleteOAuthTokensForActor, getPasswordResetByToken, markPasswordResetUsed, updatePassword } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { getBaseUrl } from "@/lib/cf";
import { enforceTurnstilePolicy } from "@/lib/turnstile";
import { validatePassword, passwordIssueCode, passwordIssueMessage } from "@/lib/password-policy";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let token: string;
  let password: string;
  let turnstileToken: string | null = null;

  if (contentType.includes("application/json")) {
    const body = await request.json() as { token?: string; password?: string; "cf-turnstile-response"?: string };
    token = (body.token ?? "").trim();
    password = body.password ?? "";
    turnstileToken = body["cf-turnstile-response"] ?? null;
  } else {
    const form = await request.formData();
    token = ((form.get("token") as string | null) ?? "").trim();
    password = (form.get("password") as string | null) ?? "";
    turnstileToken = (form.get("cf-turnstile-response") as string | null) ?? null;
  }

  if (!token || !password) {
    return json({ error: "token and password are required" }, 400);
  }

  // Same policy as registration (`lib/password-policy.ts`), so a reset cannot
  // land on a password a new account would be refused. The own-identifier rule
  // needs the account and is applied below, once the token resolves.
  const issue = validatePassword(password);
  if (issue) {
    return json({ error: passwordIssueMessage(issue), error_code: passwordIssueCode(issue) }, 422);
  }

  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";

  const turnstile = await enforceTurnstilePolicy({
    secret: env.TURNSTILE_SECRET,
    token: turnstileToken,
    remoteIp: clientIp === "unknown" ? undefined : clientIp,
    expectedHostname: new URL(getBaseUrl(env)).hostname,
    expectedAction: "reset_password",
  });
  if (!turnstile.success) {
    return json({ error: "Security check failed. Please try again.", error_code: "turnstile_error" }, 422);
  }
  const { allowed } = await checkRateLimit(env.KV, `reset:${clientIp}`, 10, 60);
  if (!allowed) {
    return json({ error: "Too many requests. Please try again later." }, 429);
  }

  const record = await getPasswordResetByToken(env.DB, token);
  if (!record) {
    return json({ error: "Invalid or expired reset token" }, 400);
  }

  if (new Date(record.expiresAt) < new Date()) {
    await markPasswordResetUsed(env.DB, token);
    return json({ error: "This reset link has expired" }, 400);
  }

  // The username is the last segment of the actor IRI, so the "must not contain
  // your own identifier" rule costs no extra read here.
  const personalIssue = validatePassword(password, [record.actorId.split("/").pop() ?? ""]);
  if (personalIssue === "personal") {
    return json({ error: passwordIssueMessage(personalIssue), error_code: passwordIssueCode(personalIssue) }, 422);
  }

  const passwordHash = await hashPassword(password);
  await updatePassword(env.DB, record.actorId, passwordHash);
  // A password reset must evict every existing session/token (the usual
  // incident response when a session may have leaked).
  await deleteOAuthTokensForActor(env.DB, record.actorId);
  await markPasswordResetUsed(env.DB, token);

  return json({ ok: true });
}
