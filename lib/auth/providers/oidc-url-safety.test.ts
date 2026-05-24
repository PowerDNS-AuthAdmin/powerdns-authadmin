/**
 * lib/auth/providers/oidc-url-safety.test.ts
 *
 * The OIDC issuer SSRF guard (M-1). The always-blocked ranges are policy- and
 * env-independent, so these literal-IP cases need no DNS and assert the guard
 * rejects the high-impact metadata/link-local targets with an "Issuer URL"
 * labeled reason. (The full range matrix is covered by url-safety.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { checkOidcIssuerUrlSafe } from "./oidc-url-safety";

describe("checkOidcIssuerUrlSafe", () => {
  it("blocks the cloud-metadata address (169.254.169.254)", async () => {
    const r = await checkOidcIssuerUrlSafe(
      "http://169.254.169.254/.well-known/openid-configuration",
    );
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reason).toMatch(/never allowed/i);
      expect(r.reason).toMatch(/169\.254\.169\.254/);
    }
  });

  it("blocks IPv6 link-local", async () => {
    const r = await checkOidcIssuerUrlSafe("http://[fe80::1]/");
    expect(r.safe).toBe(false);
  });

  it("rejects a non-http(s) scheme with an Issuer URL labeled reason", async () => {
    const r = await checkOidcIssuerUrlSafe("ftp://idp.example.com/");
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/^Issuer URL/);
  });

  it("rejects a malformed URL", async () => {
    const r = await checkOidcIssuerUrlSafe("not a url");
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reason).toMatch(/^Issuer URL is not a valid URL/);
  });

  it("allows an issuer that does not resolve (config can precede DNS; fetch-time re-check guards)", async () => {
    // `.invalid` is guaranteed never to resolve (RFC 6761). An unresolvable host
    // is not an SSRF target, so the issuer is storable; discovery re-runs the guard.
    const r = await checkOidcIssuerUrlSafe("https://idp-that-does-not-resolve.example.invalid/");
    expect(r.safe).toBe(true);
  });
});
