/**
 * One password policy for every surface that accepts a new password
 * (registration, password reset). Routes and forms import the same module, so
 * the browser can never show "valid" for something the server will reject.
 *
 * Length first: NIST SP 800-63B advises against composition rules because they
 * push people towards predictable substitutions (`Password1!`), so the only
 * composition ask here is the weakest useful one (a letter and a digit, which
 * rules out pure-wordlist and pure-numeric guesses). The deny-list is the cheap
 * half of the check — PBKDF2 cannot rescue a password that is already in every
 * breach corpus, and there is no full-text index here to match a large list
 * against.
 */
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";

/** Upper bound: an absurd input would make the KDF the whole cost of a request. */
export const MAX_PASSWORD_LENGTH = 256;

/** Frequent enough that no iteration count makes them acceptable. */
const COMMON_PASSWORDS = [
  "password", "passw0rd", "password1", "password123", "123456", "1234567", "12345678",
  "123456789", "1234567890", "123123123", "111111", "12345678910", "qwerty", "qwerty123",
  "qwertyuiop", "abc123", "abcdef", "abcdefg", "letmein", "welcome", "welcome1", "admin",
  "administrator", "iloveyou", "monkey", "dragon", "sunshine", "princess", "football",
  "baseball", "superman", "batman", "trustno1", "changeme", "temporal", "contrasena",
  "contraseña", "hola1234", "clave", "secret", "whatever", "passpass", "pass123",
];

export type PasswordIssue = "short" | "long" | "no_letter_digit" | "personal" | "common";

/**
 * Every unmet rule, in the order they should be shown. `personal` takes the
 * account's own identifiers (username, email) so the password cannot contain
 * them — the single most common way a leaked password turns into a leaked
 * account.
 */
export function passwordIssues(password: string, personal: (string | null | undefined)[] = []): PasswordIssue[] {
  const value = typeof password === "string" ? password : "";
  const issues: PasswordIssue[] = [];
  if (value.length < MIN_PASSWORD_LENGTH) issues.push("short");
  if (value.length > MAX_PASSWORD_LENGTH) issues.push("long");
  if (value.length > 0 && (!/[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/.test(value) || !/[0-9]/.test(value))) {
    issues.push("no_letter_digit");
  }
  const lower = value.toLowerCase();
  // Also try the letters-only form, so "Password123!" is caught by "password".
  const lettersOnly = lower.replace(/[^a-z\u00C0-\u024F]/g, "");
  if (COMMON_PASSWORDS.includes(lower) || COMMON_PASSWORDS.includes(lettersOnly)) issues.push("common");
  const hasPersonal = personal.some((raw) => {
    const token = (raw ?? "").trim().toLowerCase();
    if (token.length < 3) return false;
    const needle = token.includes("@") ? (token.split("@")[0] ?? "") : token;
    return needle.length >= 3 && lower.includes(needle);
  });
  if (hasPersonal) issues.push("personal");
  return issues;
}

/** The first unmet rule, or null when the password is acceptable. */
export function validatePassword(
  password: string,
  personal: (string | null | undefined)[] = []
): PasswordIssue | null {
  return passwordIssues(password, personal)[0] ?? null;
}

/**
 * Stable i18n key for an issue, used both as the API `error_code` and as the
 * client's translation key (AGENTS: browser-facing errors carry a stable code
 * next to the English text).
 */
export function passwordIssueCode(issue: PasswordIssue): string {
  switch (issue) {
    case "short":
      return "register_error_password_short";
    case "long":
      return "password_error_long";
    case "no_letter_digit":
      return "password_error_needs_letter_digit";
    case "personal":
      return "password_error_personal";
    case "common":
      return "password_error_common";
  }
}

/** English text for the API `error` field (the client translates the code). */
export function passwordIssueMessage(issue: PasswordIssue): string {
  switch (issue) {
    case "short":
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    case "long":
      return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
    case "no_letter_digit":
      return "Password must contain at least one letter and one number";
    case "personal":
      return "Password must not contain your username or email";
    case "common":
      return "That password is too common; choose another one";
  }
}
