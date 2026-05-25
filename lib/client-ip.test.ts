/**
 * lib/client-ip.test.ts
 *
 * Tests for the request-context helpers used by every route handler for
 * IP-based rate limiting + audit-log enrichment. `getClientIp` always reads
 * the fronting proxy's forwarded headers (the deployment contract is that the
 * proxy overwrites client-supplied XFF); the security-relevant behavior is
 * the IP-shape validation, which keeps junk out of rate-limit keys and audit
 * rows.
 */

import { describe, expect, it } from "vitest";
import { getClientIp, getRequestId, getRequestContext } from "./client-ip";

function h(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("getClientIp", () => {
  describe("XFF parsing", () => {
    it("always reads forwarded headers (no trust toggle)", () => {
      expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    });

    it("returns the leftmost IP from a comma-separated XFF", () => {
      expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 172.16.0.1" }))).toBe(
        "1.2.3.4",
      );
    });

    it("trims whitespace", () => {
      expect(getClientIp(h({ "x-forwarded-for": "   1.2.3.4   " }))).toBe("1.2.3.4");
    });

    it("falls through to X-Real-IP when XFF is missing", () => {
      expect(getClientIp(h({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    });

    it("XFF wins over X-Real-IP when both are present", () => {
      expect(
        getClientIp(
          h({
            "x-forwarded-for": "1.2.3.4",
            "x-real-ip": "5.6.7.8",
          }),
        ),
      ).toBe("1.2.3.4");
    });

    it("returns null when neither header is present", () => {
      expect(getClientIp(h({}))).toBeNull();
    });
  });

  describe("IP-shape validation (anti-injection)", () => {
    it("rejects clearly-non-IP values from XFF", () => {
      // A pathological proxy putting `<script>` in XFF must not
      // smuggle that string into rate-limit keys or audit logs.
      expect(getClientIp(h({ "x-forwarded-for": "<script>alert(1)</script>" }))).toBeNull();
    });

    it("rejects empty XFF leftmost when proxy double-comma'd", () => {
      // Defensive: ", 1.2.3.4" has an empty leftmost. The helper
      // should reject it (we don't pick the second value when the
      // first is empty — that would let an attacker bypass the
      // rate limiter by sending an extra leading comma).
      expect(getClientIp(h({ "x-forwarded-for": ", 1.2.3.4" }))).toBeNull();
    });

    it("accepts an IPv6 address (must contain a colon)", () => {
      expect(getClientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    });

    it("rejects out-of-range IPv4 octets (strict isIP, not a loose regex)", () => {
      // The old shape-only regex accepted `999.999.999.999`; the strict
      // `node:net` check rejects any octet > 255 so junk can't reach
      // rate-limit keys or audit rows.
      expect(getClientIp(h({ "x-forwarded-for": "999.999.999.999" }))).toBeNull();
      expect(getClientIp(h({ "x-forwarded-for": "256.0.0.1" }))).toBeNull();
      expect(getClientIp(h({ "x-forwarded-for": "1.2.3" }))).toBeNull();
    });

    it("rejects hex-but-no-colon (looks like IPv4 but isn't)", () => {
      // 0xAA is hex but not a valid IP shape. IPv6 detection requires
      // a colon to disambiguate from "bare hex string".
      expect(getClientIp(h({ "x-forwarded-for": "AA1234" }))).toBeNull();
    });

    it("rejects strings longer than 45 chars (IPv6 max length)", () => {
      const tooLong = "1".repeat(46);
      expect(getClientIp(h({ "x-forwarded-for": tooLong }))).toBeNull();
    });

    it("falls through to X-Real-IP when XFF leftmost is invalid", () => {
      // XFF first value is junk; the helper rejects it AND doesn't
      // walk to the second value, BUT it does fall through to the
      // X-Real-IP header.
      expect(
        getClientIp(
          h({
            "x-forwarded-for": "<garbage>, 1.2.3.4",
            "x-real-ip": "5.6.7.8",
          }),
        ),
      ).toBe("5.6.7.8");
    });
  });
});

describe("getRequestId", () => {
  it("returns the x-request-id header value when present", () => {
    expect(getRequestId(h({ "x-request-id": "req_abc123" }))).toBe("req_abc123");
  });

  it("returns null when the header is missing", () => {
    expect(getRequestId(h({}))).toBeNull();
  });
});

describe("getRequestContext", () => {
  it("composes ip + userAgent + requestId from headers", () => {
    const ctx = getRequestContext(
      h({
        "x-forwarded-for": "1.2.3.4",
        "user-agent": "TestRunner/1.0",
        "x-request-id": "req_xyz",
      }),
    );
    expect(ctx).toEqual({
      ip: "1.2.3.4",
      userAgent: "TestRunner/1.0",
      requestId: "req_xyz",
    });
  });

  it("returns null fields gracefully when headers are absent", () => {
    expect(getRequestContext(h({}))).toEqual({
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });
});
