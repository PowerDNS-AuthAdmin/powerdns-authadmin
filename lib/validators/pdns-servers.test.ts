/**
 * lib/validators/pdns-servers.test.ts
 *
 * Boundary coverage for the PDNS server create/update schemas. Two things
 * carry real risk and so are tested explicitly:
 *
 *   1. The credential-leak guard — a `https://user:pass@host` base URL must be
 *      REJECTED so secrets never land in the URL (where they'd leak into logs,
 *      audit snapshots, and bypass the encrypted apiKey field).
 *   2. The `/api/v1` normalization — operators type bare host:port; the schema
 *      appends the API path. A reverse-proxied custom prefix must pass through
 *      untouched. A regression here points the PDNS client at the wrong path.
 */

import { describe, expect, it } from "vitest";
import { createPdnsServerSchema } from "./pdns-servers";

const BASE_VALID = {
  slug: "primary-1",
  name: "Primary 1",
  apiKey: "changeme",
} as const;

/** Parse `baseUrl` through the full schema and return the normalized value. */
function normalizeBaseUrl(baseUrl: string): string {
  const parsed = createPdnsServerSchema.parse({ ...BASE_VALID, baseUrl });
  return parsed.baseUrl;
}

describe("pdns-servers baseUrl credential-leak guard", () => {
  it("rejects a URL carrying userinfo (username:password@host)", () => {
    const result = createPdnsServerSchema.safeParse({
      ...BASE_VALID,
      baseUrl: "https://user:pass@pdns:8081",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" ");
      expect(messages).toMatch(/username or password/i);
    }
  });

  it("rejects a URL carrying only a username", () => {
    const result = createPdnsServerSchema.safeParse({
      ...BASE_VALID,
      baseUrl: "https://admin@pdns:8081",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-http(s) scheme", () => {
    const result = createPdnsServerSchema.safeParse({
      ...BASE_VALID,
      baseUrl: "ftp://pdns:8081",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a value that isn't a URL at all", () => {
    const result = createPdnsServerSchema.safeParse({
      ...BASE_VALID,
      baseUrl: "pdns:8081",
    });
    expect(result.success).toBe(false);
  });
});

describe("pdns-servers baseUrl /api/v1 normalization", () => {
  it("appends /api/v1 to a bare host:port", () => {
    expect(normalizeBaseUrl("http://pdns:8081")).toBe("http://pdns:8081/api/v1");
  });

  it("appends /api/v1 to a host:port with a trailing slash", () => {
    expect(normalizeBaseUrl("http://pdns:8081/")).toBe("http://pdns:8081/api/v1");
  });

  it("leaves an already-correct /api/v1 path unchanged", () => {
    expect(normalizeBaseUrl("http://pdns:8081/api/v1")).toBe("http://pdns:8081/api/v1");
  });

  it("strips a trailing slash on an /api/v1 path", () => {
    expect(normalizeBaseUrl("http://pdns:8081/api/v1/")).toBe("http://pdns:8081/api/v1");
  });

  it("leaves a custom (reverse-proxied) prefix alone", () => {
    expect(normalizeBaseUrl("http://pdns:8081/custom")).toBe("http://pdns:8081/custom");
  });

  it("strips a trailing slash on a custom prefix without appending /api/v1", () => {
    expect(normalizeBaseUrl("http://pdns:8081/pdns/api/v1/")).toBe("http://pdns:8081/pdns/api/v1");
  });

  it("normalizes https the same way", () => {
    expect(normalizeBaseUrl("https://pdns.example.com")).toBe("https://pdns.example.com/api/v1");
  });
});
