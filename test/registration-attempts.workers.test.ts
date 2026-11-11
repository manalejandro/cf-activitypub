import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const aiMocks = vi.hoisted(() => ({
  evaluateRegistration: vi.fn(async () => null as { action: string; reason: string; confidence: string } | null),
}));
const authMocks = vi.hoisted(() => ({ failHash: false }));

vi.mock("@/lib/moderation/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/ai")>()),
  evaluateRegistration: aiMocks.evaluateRegistration,
}));
vi.mock("@/lib/moderation/vectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/vectors")>()),
  vectorPreScreen: vi.fn(async () => ({ autoAction: null, flagged: false, best: null, precedent: null })),
  rememberAbuse: vi.fn(async () => true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendVerificationEmail: vi.fn(async () => {}),
  sendModerationNoticeEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
}));
// Reproduce the production failure: workerd refused PBKDF2 above 100k
// iterations, so `hashPassword` threw AFTER the attempt counter had already
// been incremented — three retries banned the mailbox permanently.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    hashPassword: async (password: string) => {
      if (authMocks.failHash) {
        throw new Error("NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported");
      }
      return actual.hashPassword(password);
    },
  };
});

import { POST as REGISTER } from "@/app/api/v1/accounts/route";

const db = env.DB;
const MAILBOX = "buzon@example.test";

// A fresh client IP per call: the route rate-limits 5 registrations/IP/minute
// and the RateLimit DO outlives `resetTestStorage`, so a shared bucket would
// turn these tests into 429s. The limiter has its own tests (abuse-limits).
let ipSeq = 0;

function register(username: string, email = MAILBOX): Promise<Response> {
  ipSeq += 1;
  return REGISTER(
    new NextRequest("https://local.example.test/api/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${ipSeq % 250}` },
      body: JSON.stringify({ username, email, password: "Caballo-bateria-42" }),
    })
  );
}

async function blockCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM canonical_email_blocks").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  authMocks.failHash = false;
});

describe("registration attempt counter", () => {
  it("a server-side failure never counts toward the mailbox block", async () => {
    authMocks.failHash = true;
    for (const username of ["falla1", "falla2", "falla3"]) {
      // The handler lets the error escape (the platform answers 500).
      await expect(register(username)).rejects.toThrow(/Pbkdf2/);
    }
    expect(await blockCount()).toBe(0);

    // Once the server works again the very same mailbox registers normally:
    // this is what the incident cost real applicants.
    authMocks.failHash = false;
    const res = await register("falla4");
    expect(res.status).toBeLessThan(300);
    expect(await blockCount()).toBe(0);
  });

  it("three attempts rejected for a taken username block the mailbox, and say so", async () => {
    await register("dueno", "dueno@example.test");

    const first = await register("dueno");
    expect(first.status).toBe(422);
    expect(((await first.json()) as { error_code: string }).error_code).toBe("register_error_username_taken");

    const second = await register("dueno");
    expect(second.status).toBe(422);

    // Third attempt: the mailbox is blocked, and the answer must not claim the
    // email is taken (that sends the applicant to reset a password for an
    // account that does not exist).
    const third = await register("dueno");
    expect(third.status).toBe(422);
    const body = (await third.json()) as { error_code: string };
    expect(body.error_code).toBe("register_error_email_attempts");
    expect(await blockCount()).toBe(1);

    const after = await register("otro");
    expect(after.status).toBe(422);
    expect(((await after.json()) as { error_code: string }).error_code).toBe("register_error_email_attempts");
  });

  it("a mailbox that already registered is reported as taken, not as abuse", async () => {
    const ok = await register("propietario");
    expect(ok.status).toBeLessThan(300);

    const dup = await register("otronombre");
    expect(dup.status).toBe(422);
    expect(((await dup.json()) as { error_code: string }).error_code).toBe("register_error_email_taken");
  });
});
