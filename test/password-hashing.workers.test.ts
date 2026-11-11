import { describe, expect, it } from "vitest";
import {
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
} from "@/lib/auth";

const PASSWORD = "Caballo-bateria-42";

/**
 * These run in the **workers** project on purpose: workerd's WebCrypto rejects
 * PBKDF2 above 100,000 iterations (`NotSupportedError: Pbkdf2 failed: iteration
 * counts above 100000 are not supported`), while Node's webcrypto — where the
 * unit tests run — happily derives 600,000. Targeting OWASP's 600k therefore
 * passed every test and 500'd every registration, password reset and login
 * rehash in production.
 */
describe("password hashing in the Workers runtime", () => {
  it("derives at the platform cap and round-trips", async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS);

    const hash = await hashPassword(PASSWORD);
    const parts = hash.split(":");
    expect(parts[0]).toBe("pbkdf2");
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe(String(PBKDF2_ITERATIONS));
    expect(Number(parts[1])).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS);

    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}x`, hash)).toBe(false);
    // Already at the runtime's ceiling: no rehash loop on every sign-in.
    expect(needsPasswordRehash(hash)).toBe(false);
  });

  it("still verifies a legacy three-segment hash and migrates it", async () => {
    const [, , salt, digest] = (await hashPassword(PASSWORD)).split(":");
    const legacy = `pbkdf2:${salt}:${digest}`;

    expect(await verifyPassword(PASSWORD, legacy)).toBe(true);
    // The legacy shape records no cost, so it is rewritten on the next sign-in
    // (into the explicit shape, at the same cost).
    expect(needsPasswordRehash(legacy)).toBe(true);
  });

  it("refuses a cost this runtime cannot derive instead of throwing", async () => {
    const [, , salt, digest] = (await hashPassword(PASSWORD)).split(":");
    const impossible = `pbkdf2:600000:${salt}:${digest}`;

    // Comparing against a hash derived at 600k would need 600k iterations:
    // refuse it (the account recovers through a reset) rather than derive at a
    // different cost and compare that, and never throw inside a login.
    await expect(verifyPassword(PASSWORD, impossible)).resolves.toBe(false);
    expect(needsPasswordRehash(impossible)).toBe(false);
  });

  it("rejects malformed hashes without throwing", async () => {
    for (const bad of ["", "pbkdf2", "pbkdf2:0:aa:bb", "bcrypt:aa:bb", "pbkdf2:100000:zz:bb", "pbkdf2:100000:aa:zz"]) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });
});
