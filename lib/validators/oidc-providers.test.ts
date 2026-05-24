/**
 * lib/validators/oidc-providers.test.ts
 *
 * Unit tests for the OIDC provider Zod schemas.
 */

import { describe, expect, it } from "vitest";
import { createOidcProviderSchema, updateOidcProviderSchema } from "./oidc-providers";

/** Minimal valid payload for createOidcProviderSchema. */
const MINIMAL_CREATE = {
  slug: "my-idp",
  name: "My IdP",
  issuerUrl: "https://idp.example.com",
  clientId: "client-abc",
  clientSecret: "super-secret-value",
};

describe("createOidcProviderSchema", () => {
  it("parses a minimal payload and defaults requireEmailVerified to true", () => {
    const result = createOidcProviderSchema.parse(MINIMAL_CREATE);
    // Security default: account-takeover guard must be ON for new providers.
    expect(result.requireEmailVerified).toBe(true);
  });

  it("preserves requireEmailVerified=false when explicitly set", () => {
    const result = createOidcProviderSchema.parse({
      ...MINIMAL_CREATE,
      requireEmailVerified: false,
    });
    expect(result.requireEmailVerified).toBe(false);
  });

  it("preserves requireEmailVerified=true when explicitly set", () => {
    const result = createOidcProviderSchema.parse({
      ...MINIMAL_CREATE,
      requireEmailVerified: true,
    });
    expect(result.requireEmailVerified).toBe(true);
  });

  it("defaults scopes to 'openid profile email'", () => {
    const result = createOidcProviderSchema.parse(MINIMAL_CREATE);
    expect(result.scopes).toBe("openid profile email");
  });

  it("defaults enabled to true", () => {
    const result = createOidcProviderSchema.parse(MINIMAL_CREATE);
    expect(result.enabled).toBe(true);
  });

  it("trims stray whitespace from clientSecret", () => {
    const result = createOidcProviderSchema.parse({
      ...MINIMAL_CREATE,
      clientSecret: "  trimmed-secret  ",
    });
    expect(result.clientSecret).toBe("trimmed-secret");
  });

  it("rejects a missing clientSecret", () => {
    const { clientSecret: _omit, ...withoutSecret } = MINIMAL_CREATE;
    expect(() => createOidcProviderSchema.parse(withoutSecret)).toThrow();
  });
});

describe("updateOidcProviderSchema", () => {
  it("leaves requireEmailVerified undefined when omitted (no default)", () => {
    const result = updateOidcProviderSchema.parse({});
    expect(result.requireEmailVerified).toBeUndefined();
  });

  it("accepts requireEmailVerified=false on update", () => {
    const result = updateOidcProviderSchema.parse({ requireEmailVerified: false });
    expect(result.requireEmailVerified).toBe(false);
  });
});
