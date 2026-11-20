/**
 * Grace period after a suspension is lifted.
 *
 * An automatic decision the moderator just corrected (the Guardian, the
 * inactivity sweep, the registration sweep) must not be re-applied by the next
 * cron tick while the case is still fresh. A manual suspension — an admin or an
 * approved Guardian agent action — is never delayed, and neither is a remote
 * instance's own suspension, which we mirror rather than decide.
 *
 * The clock lives in `actors.suspension_lifted_at` (ISO-Z), written by every
 * unsuspend path. Pure helpers here keep the policy in one place, testable
 * without D1 and shared by the JS and SQL suspension paths.
 */

import { resolveLimits } from "@/lib/constants";

const DAY_MS = 86_400_000;

/** Effective cooldown in days (0 disables it) from the instance limits. */
export function suspensionCooldownDays(env: Record<string, unknown>): number {
  return resolveLimits(env).suspensionCooldownDays;
}

/**
 * A lift more recent than this is inside the grace period. `null` means the
 * cooldown is disabled, so every caller can simply compare against it.
 */
export function suspensionCooldownCutoff(days: number, now: number = Date.now()): string | null {
  if (days <= 0) return null;
  return new Date(now - days * DAY_MS).toISOString();
}

/**
 * Whether a recently lifted suspension should hold an *automatic*
 * re-suspension. ISO-Z strings are lexicographically ordered, so a plain
 * string comparison is enough — both values come from `toISOString()`.
 */
export function isInSuspensionCooldown(
  actor: { suspensionLiftedAt?: string | null },
  cutoff: string | null
): boolean {
  if (!cutoff || !actor.suspensionLiftedAt) return false;
  return actor.suspensionLiftedAt > cutoff;
}

/** Bare-column predicate for the batch sweeps (never wrap the column in a function). */
export const COOLDOWN_WHERE_SQL = "AND (suspension_lifted_at IS NULL OR suspension_lifted_at <= ?)";

/**
 * The value bound by the batch sweeps. A disabled cooldown binds a far-future
 * timestamp so the SQL shape never changes and every real lift passes.
 */
export function cooldownCutoffBound(env: Record<string, unknown>, now?: number): string {
  return suspensionCooldownCutoff(suspensionCooldownDays(env), now) ?? "9999-12-31T23:59:59.999Z";
}
