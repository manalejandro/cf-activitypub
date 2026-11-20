import { describe, expect, it } from "vitest";
import {
  cooldownCutoffBound,
  isInSuspensionCooldown,
  suspensionCooldownCutoff,
  suspensionCooldownDays,
} from "@/lib/moderation/cooldown";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("suspension cooldown", () => {
  it("reads the instance limit, with 0 disabling the grace period", () => {
    expect(suspensionCooldownDays({ SUSPENSION_COOLDOWN_DAYS: "3" })).toBe(3);
    expect(suspensionCooldownDays({ SUSPENSION_COOLDOWN_DAYS: "0" })).toBe(0);
    expect(suspensionCooldownDays({})).toBe(7);
  });

  it("computes an ISO cutoff, or null when disabled", () => {
    expect(suspensionCooldownCutoff(7, NOW)).toBe("2026-11-13T12:00:00.000Z");
    expect(suspensionCooldownCutoff(0, NOW)).toBeNull();
    expect(suspensionCooldownCutoff(-1, NOW)).toBeNull();
  });

  it("holds only lifts more recent than the cutoff", () => {
    const cutoff = suspensionCooldownCutoff(7, NOW)!;
    expect(isInSuspensionCooldown({ suspensionLiftedAt: "2026-11-19T12:00:00.000Z" }, cutoff)).toBe(true);
    expect(isInSuspensionCooldown({ suspensionLiftedAt: "2026-11-13T12:00:00.000Z" }, cutoff)).toBe(false);
    expect(isInSuspensionCooldown({ suspensionLiftedAt: "2026-11-21T12:00:00.000Z" }, cutoff)).toBe(true);
    expect(isInSuspensionCooldown({ suspensionLiftedAt: null }, cutoff)).toBe(false);
    expect(isInSuspensionCooldown({ suspensionLiftedAt: "2026-11-19T12:00:00.000Z" }, null)).toBe(false);
  });

  it("binds a far-future cutoff when disabled so the SQL shape never changes", () => {
    expect(cooldownCutoffBound({ SUSPENSION_COOLDOWN_DAYS: "0" }, NOW)).toBe("9999-12-31T23:59:59.999Z");
  });
});
