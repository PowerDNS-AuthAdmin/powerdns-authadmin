/**
 * lib/auth/providers/oidc.guarded-fetch.test.ts
 *
 * The OIDC outbound SSRF hardening (sec/oidc-pinning): openid-client must use
 * the guarded + pinned `customFetch` for discovery AND the token exchange, and
 * that fetch must REFUSE to connect when the SSRF guard rejects the issuer's
 * current resolution — closing the DNS-rebinding / TOCTOU window where the
 * token POST (carrying the client_secret) could be rebound to an internal host.
 *
 * Fully hermetic: openid-client and the DB repo are stubbed; the guard is
 * driven directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardResult } from "@/lib/net/pinned-fetch";

const PUBLIC_IP = "203.0.113.10";

// A stand-in symbol used as openid-client's `customFetch` key, so we can read
// what oidc.ts attaches to the options / Configuration.
const CUSTOM_FETCH = Symbol("customFetch");

const discoveryMock = vi.fn();
const buildAuthUrlMock = vi.fn();

vi.mock("openid-client", () => {
  class Configuration {
    public metadata: unknown;
    public store: Record<symbol, unknown> = {};
    constructor(metadata: unknown) {
      this.metadata = metadata;
    }
    serverMetadata(): { token_endpoint_auth_methods_supported: string[] } {
      return { token_endpoint_auth_methods_supported: ["client_secret_post"] };
    }
  }
  return {
    customFetch: CUSTOM_FETCH,
    discovery: (...args: unknown[]) => discoveryMock(...args) as unknown,
    Configuration,
    buildAuthorizationUrl: (...args: unknown[]) => buildAuthUrlMock(...args) as unknown,
    randomPKCECodeVerifier: () => "verifier",
    calculatePKCECodeChallenge: () => Promise.resolve("challenge"),
    randomNonce: () => "nonce",
    ClientSecretBasic: vi.fn(),
    ClientSecretPost: vi.fn(),
    None: vi.fn(),
  };
});

// Keep the crypto + DB layers out of the test.
vi.mock("@/lib/crypto/encryption", () => ({
  decrypt: (v: string) => v,
  looksLikeEnvelope: () => false,
  encrypt: (v: string) => v,
}));
vi.mock("@/lib/db/repositories/oidc-providers", () => ({
  findOidcProviderBySlug: vi.fn(),
}));

// Drive the SSRF guard outcome.
const guardMock = vi.fn<(url: string) => Promise<GuardResult>>();
vi.mock("./oidc-url-safety", () => ({
  checkOidcIssuerUrlSafe: (url: string) => guardMock(url),
  assertSafeOidcIssuerUrl: async (url: string) => {
    const r = await guardMock(url);
    if (!r.safe) throw new Error(r.reason);
  },
}));

function provider() {
  return {
    id: "p1",
    slug: "test",
    name: "Test",
    issuerUrl: "https://idp.example.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    scopes: "openid email",
    claimEmail: "email",
    claimName: "name",
    claimGroups: "groups",
    source: "db" as const,
    allowedEmailDomains: null,
    groupMappings: null,
    requireEmailVerified: true,
  };
}

describe("oidc.ts — guarded + pinned customFetch", () => {
  beforeEach(() => {
    discoveryMock.mockReset();
    buildAuthUrlMock.mockReset();
    guardMock.mockReset();
    guardMock.mockResolvedValue({ safe: true, addresses: [PUBLIC_IP] });
    buildAuthUrlMock.mockReturnValue(new URL("https://idp.example.test/authorize"));
  });
  afterEach(() => vi.clearAllMocks());

  it("passes a customFetch into openid-client discovery", async () => {
    const { invalidateOidcConfigCache, buildAuthorizationUrl } = await import("./oidc");
    invalidateOidcConfigCache();
    discoveryMock.mockImplementation(
      (_url, _id, _secret, _auth, options: Record<symbol, unknown>) => {
        // openid-client assigns the passed customFetch onto the resolved config.
        const config = {
          [CUSTOM_FETCH]: options[CUSTOM_FETCH],
          serverMetadata: () => ({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
        };
        return Promise.resolve(config);
      },
    );

    await buildAuthorizationUrl(provider(), "https://app.example.test/callback");

    expect(discoveryMock).toHaveBeenCalledTimes(1);
    const optsArg = discoveryMock.mock.calls[0]?.[4] as Record<symbol, unknown>;
    expect(typeof optsArg[CUSTOM_FETCH]).toBe("function");
  });

  it("the supplied customFetch refuses to connect when the guard rejects", async () => {
    const { invalidateOidcConfigCache, buildAuthorizationUrl } = await import("./oidc");
    invalidateOidcConfigCache();
    let captured: ((url: string) => Promise<Response>) | undefined;
    discoveryMock.mockImplementation(
      (_url, _id, _secret, _auth, options: Record<symbol, unknown>) => {
        captured = options[CUSTOM_FETCH] as (url: string) => Promise<Response>;
        return Promise.resolve({
          [CUSTOM_FETCH]: options[CUSTOM_FETCH],
          serverMetadata: () => ({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
        });
      },
    );

    await buildAuthorizationUrl(provider(), "https://app.example.test/callback");
    expect(captured).toBeDefined();

    // Now flip the guard to reject (the DNS-rebind moment) and invoke the
    // captured fetch as openid-client would for the token exchange.
    guardMock.mockResolvedValue({ safe: false, reason: "resolves to 169.254.169.254" });
    await expect(captured!("https://idp.example.test/token")).rejects.toThrow(/unsafe URL/i);
  });

  it("rejects discovery up front when the pre-check guard fails", async () => {
    const { invalidateOidcConfigCache, buildAuthorizationUrl } = await import("./oidc");
    invalidateOidcConfigCache();
    guardMock.mockResolvedValue({ safe: false, reason: "resolves to 127.0.0.1" });

    await expect(
      buildAuthorizationUrl(provider(), "https://app.example.test/callback"),
    ).rejects.toThrow(/127\.0\.0\.1/);
    expect(discoveryMock).not.toHaveBeenCalled();
  });
});
