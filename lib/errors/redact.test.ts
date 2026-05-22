import { describe, expect, it } from "vitest";
import { redact, safeErrorMessage } from "./redact";

describe("redact", () => {
  it("redacts URL-embedded passwords, keeping scheme/user/host", () => {
    expect(redact("connect failed: postgres://user:hunter2@db.host:5432/app")).toBe(
      "connect failed: postgres://user:[Redacted]@db.host:5432/app",
    );
  });

  it("redacts Bearer and Basic tokens", () => {
    expect(redact("Authorization: Bearer abc.def.ghijklmnop")).toContain("Bearer [Redacted]");
    expect(redact("Authorization: Basic dXNlcjpwYXNz")).toContain("Basic [Redacted]");
  });

  it("redacts an X-API-Key header value", () => {
    expect(redact("sent X-API-Key: super-secret-key-value")).toBe("sent X-API-Key: [Redacted]");
  });

  it("redacts a PEM private-key block", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg...\nkqhkiG9w0\n-----END PRIVATE KEY-----";
    expect(redact(`key: ${pem}`)).toBe("key: [Redacted PEM block]");
  });

  it("redacts personal-access-token shapes", () => {
    expect(redact("token pda_pat_abcdefgh12345678")).toBe("token pda_pat_[Redacted]");
    expect(redact("token ghp_abcdefgh12345678")).toBe("token ghp_[Redacted]");
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redact(`cookie=${jwt}`)).toBe("cookie=[Redacted JWT]");
  });

  it("leaves benign prose untouched", () => {
    const s = "user updated their profile; no secrets here. pat_ mentioned in docs.";
    expect(redact(s)).toBe(s);
  });

  it("returns falsy input unchanged", () => {
    expect(redact("")).toBe("");
  });
});

describe("safeErrorMessage", () => {
  it("redacts an Error's message", () => {
    const err = new Error("db at postgres://u:p4ss@h/db is down");
    expect(safeErrorMessage(err)).toBe("db at postgres://u:[Redacted]@h/db is down");
  });

  it("stringifies and redacts a non-Error throw", () => {
    expect(safeErrorMessage("Bearer leakedtokenvalue")).toBe("Bearer [Redacted]");
  });
});
