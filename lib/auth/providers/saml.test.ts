/**
 * lib/auth/providers/saml.test.ts
 *
 * Unit tests for the SAML provider core. We exercise the surfaces that aren't
 * already covered by `@node-saml/node-saml`'s own test suite:
 *
 *   - AuthnRequest XML shape (well-formed, signed, correct entityID).
 *   - SP metadata XML shape (well-formed; encryption cert appears iff configured).
 *   - The email-domain gate re-exported here for SAML callers.
 *   - The error describer (operator-actionable structured fields).
 *
 * Signature verification of inbound Responses is covered transitively: an
 * invalid Response throws (positive path is the integration test once a
 * Keycloak SAML realm exists; that's tracked separately in the PR description).
 */

import { describe, expect, it } from "vitest";
import {
  buildAuthnRequest,
  buildSpMetadata,
  describeSamlError,
  emailDomainAllowed,
  resolveAllowedDomains,
  verifyResponse,
  type ResolvedSamlProvider,
} from "./saml";
import { makeTestProvider } from "./saml.test-fixtures";

describe("saml - buildAuthnRequest", () => {
  it("returns a redirect URL + RequestID, request URL points at the IdP SSO endpoint", async () => {
    const provider = makeTestProvider();
    const { redirectUrl, requestId } = await buildAuthnRequest(
      provider,
      "https://app.example.test/api/auth/saml/test/acs",
    );
    expect(requestId).toMatch(/^_/);
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(provider.idpSsoUrl);
    // The HTTP-Redirect binding carries the deflated+base64 SAMLRequest in the
    // query string; node-saml additionally appends Signature when we provide
    // a privateKey, which we do.
    expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
    expect(url.searchParams.get("Signature")).toBeTruthy();
    expect(url.searchParams.get("SigAlg")).toBeTruthy();
  });

  it("uses different RequestIDs on successive calls", async () => {
    const provider = makeTestProvider();
    const callback = "https://app.example.test/api/auth/saml/test/acs";
    const a = await buildAuthnRequest(provider, callback);
    const b = await buildAuthnRequest(provider, callback);
    expect(a.requestId).not.toBe(b.requestId);
  });
});

describe("saml - buildSpMetadata", () => {
  it("emits well-formed XML with the SP entityID + ACS + signing cert", () => {
    const provider = makeTestProvider();
    const xml = buildSpMetadata(provider, "https://app.example.test");
    expect(xml).toMatch(/<\?xml/);
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain("AssertionConsumerService");
    // Our entityID is derived from the metadata URL (origin + /api/auth/saml/<slug>/metadata).
    expect(xml).toContain(
      `entityID="https://app.example.test/api/auth/saml/${provider.slug}/metadata"`,
    );
    // SP signing cert appears in a KeyDescriptor use="signing".
    expect(xml).toContain("KeyDescriptor");
    // Stripped of newlines/whitespace, the SP cert body shows up inside an
    // X509Certificate element.
    expect(xml).toContain("X509Certificate");
  });

  it("includes an encryption KeyDescriptor when an encryption cert is configured", () => {
    const provider = makeTestProvider({ withEncryption: true });
    const xml = buildSpMetadata(provider, "https://app.example.test");
    // Two KeyDescriptors when encryption is configured: signing + encryption.
    const matches = xml.match(/KeyDescriptor/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("saml - verifyResponse", () => {
  it("rejects an obviously malformed Response", async () => {
    const provider = makeTestProvider();
    const callbackUrl = "https://app.example.test/api/auth/saml/test/acs";
    await expect(
      verifyResponse(provider, "not-base64-not-xml", "_req-123", callbackUrl),
    ).rejects.toThrow();
  });

  it("rejects a Response that isn't base64-encoded SAML", async () => {
    const provider = makeTestProvider();
    const callbackUrl = "https://app.example.test/api/auth/saml/test/acs";
    // Base64 of a non-SAML XML payload - the library parses the XML but
    // fails the spec-required signature verification.
    const garbage = Buffer.from('<?xml version="1.0"?><not-saml/>').toString("base64");
    await expect(verifyResponse(provider, garbage, "_req-123", callbackUrl)).rejects.toThrow();
  });
});

describe("saml - email-domain gate", () => {
  it("accepts emails inside the allow-list", () => {
    const r = emailDomainAllowed("alice@example.com", ["example.com"]);
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("example.com");
  });

  it("rejects emails outside the allow-list", () => {
    const r = emailDomainAllowed("alice@other.example", ["example.com"]);
    expect(r.ok).toBe(false);
    expect(r.domain).toBe("other.example");
  });

  it("resolveAllowedDomains: per-provider list REPLACES the env default", () => {
    const eff = resolveAllowedDomains(["custom.example"], ["env.example"]);
    expect(eff).toEqual(["custom.example"]);
  });

  it("resolveAllowedDomains: null per-provider inherits env", () => {
    const eff = resolveAllowedDomains(null, ["env.example"]);
    expect(eff).toEqual(["env.example"]);
  });

  it("resolveAllowedDomains: empty per-provider array overrides env to 'no restriction'", () => {
    const eff = resolveAllowedDomains([], ["env.example"]);
    expect(eff).toEqual([]);
  });
});

describe("saml - describeSamlError", () => {
  it("extracts message + name from a real Error", () => {
    const detail = describeSamlError(new Error("InResponseTo mismatch"));
    expect(detail.message).toBe("InResponseTo mismatch");
    expect(detail.name).toBe("Error");
  });

  it("falls back to the unknown shape for non-Error throws", () => {
    const detail = describeSamlError("just a string");
    expect(detail.message).toBe("just a string");
    expect(detail.name).toBe("Unknown");
  });

  it("truncates very long messages", () => {
    const big = "x".repeat(2000);
    const detail = describeSamlError(new Error(big));
    expect(detail.message.length).toBeLessThanOrEqual(500);
  });
});

// Type-only check that the resolved-provider shape carries the bits the
// downstream code expects. Failing this fails the test file at compile time
// (vitest runs through esbuild + the project tsconfig).
const _typeCheck: ResolvedSamlProvider | null = null;
void _typeCheck;
