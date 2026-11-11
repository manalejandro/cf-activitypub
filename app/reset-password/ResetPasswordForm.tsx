"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, translateKey } from "@/lib/i18n";
import { LanguagePicker } from "@/components/LanguagePicker";
import TurnstileWidget from "@/components/TurnstileWidget";
import { MAX_PASSWORD_LENGTH, passwordIssues, type PasswordIssue } from "@/lib/password-policy";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";

export default function ResetPasswordForm({ turnstileSiteKey = "" }: { turnstileSiteKey?: string } = {}) {
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  // The policy the server applies (lib/password-policy.ts), minus the
  // own-identifier rule: this form has no account context, and the route checks
  // that one as soon as the token resolves.
  const passwordProblems = passwordIssues(password);
  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  function passwordIssueText(issue: PasswordIssue): string {
    switch (issue) {
      case "short":
        return t.register_error_password_short.replace("{min}", String(MIN_PASSWORD_LENGTH));
      case "long":
        return t.password_error_long.replace("{max}", String(MAX_PASSWORD_LENGTH));
      case "no_letter_digit":
        return t.password_error_needs_letter_digit;
      case "personal":
        return t.password_error_personal;
      case "common":
        return t.password_error_common;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (passwordProblems.length > 0) {
      setError(passwordIssueText(passwordProblems[0]));
      return;
    }
    if (password !== confirmPassword) {
      setError(t.register_password_mismatch);
      return;
    }

    if (turnstileSiteKey && !turnstileToken) {
      setError(t.turnstile_error);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, "cf-turnstile-response": turnstileToken }),
      });

      const data = await res.json() as { error?: string; error_code?: string };

      if (!res.ok) {
        setError(translateKey(t, data.error_code, data.error) ?? data.error ?? "Something went wrong");
        return;
      }

      setSuccess(true);
    } catch {
      setError(t.network_error);
    } finally {
      setLoading(false);
    }
  }

  const inlineError = {
    background: "rgba(248,113,113,0.1)",
    border: "1px solid rgba(248,113,113,0.3)",
    color: "var(--danger)",
    borderRadius: "var(--radius)",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
  };

  const inlineSuccess = {
    background: "rgba(52,211,153,0.1)",
    border: "1px solid rgba(52,211,153,0.3)",
    color: "var(--success, #34d399)",
    borderRadius: "var(--radius)",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
  };

  if (!token) {
    return (
      <div
        className="force-light flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="" width={52} height={52}  unoptimized />
            </Link>
          </div>
          <div className="card p-8">
            <div style={inlineError}>{t.reset_password_invalid}</div>
          </div>
          <p style={{ textAlign: "center", marginTop: "1.25rem" }}>
            <Link href="/login" style={{ color: "var(--accent)", fontSize: "0.875rem" }}>
              {t.register_signin}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="force-light flex flex-col items-center justify-center min-h-screen px-4"
      style={{ background: "var(--bg)" }}
    >
      <div style={{ position: "absolute", top: "1rem", right: "1rem" }}>
        <LanguagePicker />
      </div>

      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="" width={52} height={52}  unoptimized />
          </Link>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.reset_password_title}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            {t.reset_password_sub}
          </p>
        </div>

        <div className="card p-8">
          {success ? (
            <div style={inlineSuccess}>{t.reset_password_success}</div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {error && <div style={inlineError}>{error}</div>}

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_password}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-describedby="reset-password-rules"
                  aria-invalid={password.length > 0 && passwordProblems.length > 0}
                />
                <p id="reset-password-rules" style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>
                  {t.register_password_rules
                    .replace("{min}", String(MIN_PASSWORD_LENGTH))
                    .replace("{max}", String(MAX_PASSWORD_LENGTH))}
                </p>
                {password.length > 0 && passwordProblems.length > 0 && (
                  <p role="alert" style={{ fontSize: "0.75rem", color: "var(--danger)", margin: 0 }}>
                    {passwordIssueText(passwordProblems[0])}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_confirm_password}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={MAX_PASSWORD_LENGTH}
                  aria-invalid={passwordMismatch}
                />
                {passwordMismatch && (
                  <p role="alert" style={{ fontSize: "0.75rem", color: "var(--danger)", margin: 0 }}>
                    {t.register_password_mismatch}
                  </p>
                )}
              </div>

              <TurnstileWidget siteKey={turnstileSiteKey} action="reset_password" onToken={setTurnstileToken} />

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || (Boolean(turnstileSiteKey) && !turnstileToken)}
              >
                {loading ? t.login_submitting : t.reset_password_submit}
              </button>
            </form>
          )}
        </div>

        {success && (
          <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            <Link href="/login" style={{ color: "var(--accent)" }}>
              {t.register_signin}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
