import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  passwordIssueCode,
  passwordIssues,
  validatePassword,
} from "@/lib/password-policy";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";

const OK = "Caballo-bateria-42";

describe("password policy", () => {
  it("accepts a long password with a letter and a digit", () => {
    expect(validatePassword(OK, ["newbie", "newbie@example.com"])).toBeNull();
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(OK.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it("flags each rule, in the order the form shows them", () => {
    expect(passwordIssues("Ab1")).toEqual(["short"]);
    expect(passwordIssues(`${"x".repeat(MAX_PASSWORD_LENGTH)}1`)).toEqual(["long"]);
    expect(passwordIssues("sololetraslargas")).toEqual(["no_letter_digit"]);
    expect(passwordIssues("987654321012345")).toEqual(["no_letter_digit"]);
    expect(passwordIssues("password123")).toEqual(["short", "common"]);
    expect(passwordIssues("password1234567")).toEqual(["common"]);
  });

  it("catches a common password behind punctuation and case", () => {
    // The letters-only projection is what finds `Password!123`.
    expect(passwordIssues("Password!123")).toEqual(["common"]);
    expect(passwordIssues("QWERTY123456")).toEqual(["common"]);
  });

  it("refuses the account's own identifiers, including the email local part", () => {
    expect(validatePassword("newbie-corcel-9", ["newbie", "someone@example.com"])).toBe("personal");
    expect(validatePassword("corcel-alicia-9", ["alicia", "alicia@example.com"])).toBe("personal");
    expect(validatePassword(OK, ["alicia", "alicia@example.com"])).toBeNull();
    // Short identifiers (<3 chars) are not a rule on their own.
    expect(validatePassword(OK, ["bo", "bo@x.example"])).toBeNull();
  });

  it("maps every issue to a stable i18n error code", () => {
    expect(passwordIssueCode("short")).toBe("register_error_password_short");
    expect(passwordIssueCode("long")).toBe("password_error_long");
    expect(passwordIssueCode("no_letter_digit")).toBe("password_error_needs_letter_digit");
    expect(passwordIssueCode("personal")).toBe("password_error_personal");
    expect(passwordIssueCode("common")).toBe("password_error_common");
  });

  it("tolerates a missing or non-string password", () => {
    expect(passwordIssues(undefined as unknown as string)).toEqual(["short"]);
    expect(passwordIssues("", ["newbie"])).toEqual(["short"]);
  });
});
