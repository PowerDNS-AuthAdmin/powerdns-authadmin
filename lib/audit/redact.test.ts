import { describe, expect, it } from "vitest";
import { redactSnapshot } from "./redact";

describe("redactSnapshot", () => {
  it("replaces values of known secret field names with the redaction marker", () => {
    const out = redactSnapshot({
      email: "alice@example.com",
      password: "hunter2",
      passwordHash: "$argon2id$...",
      details: { token: "ghp_abc", count: 3 },
    });
    expect(out).toEqual({
      email: "alice@example.com",
      password: "[Redacted]",
      passwordHash: "[Redacted]",
      details: { token: "[Redacted]", count: 3 },
    });
  });

  it("redacts a top-level `key` field (TSIG-style HMAC secrets)", () => {
    // The TSIG detail shape uses bare `key` for the base64 HMAC
    // secret. Without this entry in REDACT_FIELDS, an audit snapshot
    // of a TSIG mutation would persist the shared secret.
    const out = redactSnapshot({
      id: "primary.",
      name: "primary",
      algorithm: "hmac-sha256",
      key: "AbCdEf0123456789AbCdEf01==",
    });
    expect(out).toMatchObject({
      id: "primary.",
      name: "primary",
      algorithm: "hmac-sha256",
      key: "[Redacted]",
    });
  });

  it("recurses through arrays and nested objects", () => {
    const out = redactSnapshot({
      assignments: [
        { id: 1, secret: "abc" },
        { id: 2, secret: "def" },
      ],
    });
    expect(out).toEqual({
      assignments: [
        { id: 1, secret: "[Redacted]" },
        { id: 2, secret: "[Redacted]" },
      ],
    });
  });

  it("passes primitives through unchanged", () => {
    expect(redactSnapshot("hello")).toBe("hello");
    expect(redactSnapshot(42)).toBe(42);
    expect(redactSnapshot(null)).toBe(null);
    expect(redactSnapshot(undefined)).toBe(undefined);
  });

  it("does not mutate the input", () => {
    const input = { password: "hunter2", email: "alice@example.com" };
    const out = redactSnapshot(input);
    expect(input.password).toBe("hunter2"); // original untouched
    expect(out).not.toBe(input); // fresh object
  });
});
