/**
 * lib/auth/providers/oidc.ts
 *
 * OIDC provider dispatcher. Providers are stored in the `oidc_providers`
 * table and managed from `/admin/authentication/oidc`. The env-driven config
 * (`OIDC_*`) is surfaced as a single, READ-ONLY provider ("Configured by
 * ENV") that is always offered alongside DB providers — both the login page
 * and the admin list show it. A DB provider with the same slug takes
 * precedence (shadows the env one). The env provider is edited by changing
 * environment variables, not through the UI, and can't carry group→role
 * mappings (use a DB provider for those).
 *
 * Flow:
 *   1. /api/auth/oidc/<slug>/initiate → resolve provider config → build the
 *      authorization URL with PKCE + state, set HttpOnly cookies, redirect.
 *   2. IdP redirects back to /api/auth/oidc/<slug>/callback with `code` and
 *      `state`. The handler verifies state, exchanges code for tokens,
 *      validates the ID token, and returns a `VerifiedIdentity`.
 *
 * `openid-client` does the heavy lifting (discovery, signature verification,
 * claim extraction). We hold the policy: which slug → which config, claim
 * mapping per provider, error surfacing.
 */

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import * as oidc from "openid-client";

import { decrypt, looksLikeEnvelope } from "@/lib/crypto/encryption";
import { findOidcProviderBySlug } from "@/lib/db/repositories/oidc-providers";
import type { OidcGroupMapping, OidcProvider } from "@/lib/db/schema";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { makeGuardedFetch } from "@/lib/net/pinned-fetch";
import { assertSafeOidcIssuerUrl, checkOidcIssuerUrlSafe } from "./oidc-url-safety";
import type { VerifiedIdentity } from "./types";

/**
 * Guarded + pinned fetch for ALL openid-client traffic (discovery, JWKS, and
 * the token-exchange POST that carries the `client_secret`). Re-runs the SSRF
 * guard immediately before each connection and pins the validated address into
 * undici's connect, closing the DNS-rebinding / TOCTOU window between the guard
 * the call site ran and openid-client's own independent re-resolution. Also
 * forces `redirect: "error"` (openid-client would otherwise pass "manual").
 *
 * `discovery()` assigns whatever `customFetch` it's given to the resolved
 * `Configuration`, so the same guarded fetch flows to every later request on
 * that config. {@link attachGuardedFetch} re-attaches it to Configurations we
 * rebuild by hand (auth-method swaps), since a fresh `new oidc.Configuration`
 * starts without it.
 */
// `makeGuardedFetch` returns the standard Fetch surface; openid-client's
// `CustomFetch` types `body` more narrowly (its `FetchBody`) and requires the
// options arg. The wrapper accepts any `RequestInit` and forwards it to undici
// unchanged, so it satisfies the contract at runtime — bridge the nominal gap.
const guardedOidcFetch = makeGuardedFetch(checkOidcIssuerUrlSafe) as unknown as oidc.CustomFetch;

/**
 * Attach {@link guardedOidcFetch} to a Configuration via openid-client's
 * `customFetch` symbol so its token / userinfo requests go only to the
 * guard-validated address. Returns the same instance for chaining.
 */
function attachGuardedFetch(config: oidc.Configuration): oidc.Configuration {
  config[oidc.customFetch] = guardedOidcFetch;
  return config;
}

/**
 * Resolved provider config — uniform shape whether the row came from the DB
 * or the env fallback.
 */
export interface ResolvedOidcProvider {
  /**
   * DB row id when source = "db"; null for the env-fallback provider
   * (which has no FK target). Group-sync uses this to tag managed role
   * assignments; env providers don't support group mappings.
   */
  id: string | null;
  slug: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  claimEmail: string;
  claimName: string;
  /** Claim name carrying group memberships ("groups" by default). */
  claimGroups: string;
  source: "db" | "env";
  /**
   * Per-provider email-domain override (S-7 follow-up). `null` means
   * "inherit the env default"; an array (possibly empty) means "use
   * this list verbatim for this provider, ignoring env." Env-source
   * providers always have `null` here — env has no per-provider
   * override mechanism; env IS the env-level default.
   */
  allowedEmailDomains: string[] | null;
  /** Group → role mapping rules. Null for env-source providers. */
  groupMappings: OidcGroupMapping[] | null;
  /**
   * When false, the callback handler accepts a sign-in even if the
   * IdP didn't emit `email_verified: true`. Default `true` — the
   * account-takeover guard is on. Operators relax this only for IdPs
   * that don't emit the claim at all (custom OIDC bridges, some
   * SAML→OIDC translators).
   */
  requireEmailVerified: boolean;
}

/**
 * Cached discovery configurations, keyed by provider slug + a hash of the
 * underlying credential material so a client_secret rotation invalidates the
 * cache automatically.
 */
const configCache = new Map<string, oidc.Configuration>();

function cacheKey(p: ResolvedOidcProvider): string {
  // The clientSecret is the high-entropy bit; including it (not its hash) is
  // fine because the cache lives only in-process — but conceptually it's a
  // cache key, so we slice it down for shorter map keys.
  return `${p.slug}|${p.issuerUrl}|${p.clientId}|${p.clientSecret.slice(0, 16)}`;
}

function fromDbRow(row: OidcProvider): ResolvedOidcProvider {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecret: unwrapClientSecret(row.clientSecretEncrypted, row.slug),
    scopes: row.scopes,
    claimEmail: row.claimEmail,
    claimName: row.claimName,
    claimGroups: row.claimGroups,
    source: "db",
    allowedEmailDomains: row.allowedEmailDomains,
    groupMappings: row.groupMappings,
    requireEmailVerified: row.requireEmailVerified,
  };
}

/**
 * Decrypt the stored client secret. Defensive against double-encryption
 * — observed in the wild when an earlier admin path encrypted an already-
 * encrypted envelope, leaving `decrypt()` returning a value that itself
 * still looks like an envelope. Unwrap recursively (bounded depth so a
 * pathological row can't loop) and log a warning the first time it
 * happens so an operator can re-save the secret to clean the row.
 */
function unwrapClientSecret(envelope: string, providerSlug: string): string {
  const MAX_DEPTH = 4;
  let value = decrypt(envelope, "oidc-client-secret");
  let depth = 1;
  while (looksLikeEnvelope(value) && depth < MAX_DEPTH) {
    try {
      const next = decrypt(value, "oidc-client-secret");
      logger.warn(
        { provider: providerSlug, depth, secret_len: next.length },
        "oidc.secret.double-encrypted",
      );
      value = next;
      depth += 1;
    } catch {
      // Inner decrypt failed — the value happens to look like an
      // envelope but isn't one of ours. Stop and use what we have;
      // authentik will return invalid_client if it's wrong, which
      // surfaces in the callback failure log.
      break;
    }
  }
  return value;
}

function fromEnv(): ResolvedOidcProvider | null {
  if (
    !env.OIDC_ENABLED ||
    !env.OIDC_PROVIDER_ID ||
    !env.OIDC_PROVIDER_NAME ||
    !env.OIDC_ISSUER_URL ||
    !env.OIDC_CLIENT_ID ||
    !env.OIDC_CLIENT_SECRET
  ) {
    return null;
  }
  return {
    id: null,
    slug: env.OIDC_PROVIDER_ID,
    name: env.OIDC_PROVIDER_NAME,
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES,
    claimEmail: env.OIDC_CLAIM_EMAIL,
    claimName: env.OIDC_CLAIM_NAME,
    claimGroups: "groups",
    source: "env",
    // Env providers don't carry a per-provider override — env IS the
    // env-level default for itself. The resolver returns env's
    // allow-list directly in this case (via `resolveAllowedDomains(null,
    // envDefault)`).
    allowedEmailDomains: null,
    // Env-source providers don't carry group mappings (env has no
    // structured slot for them). Operators wanting group→role
    // materialisation must use a DB-source provider.
    groupMappings: null,
    // Env providers don't expose this knob today — env-deployed
    // setups predate per-provider relaxation. Inherit the secure
    // default; operators wanting to relax should move to a DB
    // provider where the toggle lives.
    requireEmailVerified: true,
  };
}

/**
 * Safe, secret-free descriptor of the env-configured provider for UI
 * surfaces (the login button + the admin list row). Null when the env
 * provider isn't configured. Unlike a DB provider it is READ-ONLY — edited
 * by changing environment variables, not through the admin UI.
 */
export interface EnvOidcProviderSummary {
  slug: string;
  name: string;
  issuerUrl: string;
  scopes: string;
  /** Env-level new-user email allow-list (empty array = no restriction). */
  allowedEmailDomains: string[];
}

export function envOidcProviderSummary(): EnvOidcProviderSummary | null {
  const p = fromEnv();
  if (!p) return null;
  return {
    slug: p.slug,
    name: p.name,
    issuerUrl: p.issuerUrl,
    scopes: p.scopes,
    allowedEmailDomains: env.OIDC_ALLOWED_EMAIL_DOMAINS,
  };
}

/**
 * Resolve a provider config by slug. Looks up the DB first; if there's no
 * enabled DB row with that slug and the env provider's slug matches, returns
 * the env-synthesised provider. So a DB provider always shadows the env one
 * on a slug collision. Returns null when nothing matches — caller decides the
 * error (typically 404).
 *
 * The DB row must be `enabled=true` to be returned.
 */
export async function resolveOidcProvider(slug: string): Promise<ResolvedOidcProvider | null> {
  const row = await findOidcProviderBySlug(slug);
  if (row?.enabled) return fromDbRow(row);

  const envProvider = fromEnv();
  if (envProvider?.slug === slug) return envProvider;

  return null;
}

/**
 * 8-char SHA-256 fingerprint of a secret. Safe to log — the
 * full secret can't be reversed from 8 hex chars (2^32 search space
 * + the strings we care about are 60+ chars of entropy), and the
 * operator can compare it locally:
 *
 *   echo -n "secret-from-authentik-clipboard" | sha256sum | head -c 8
 *
 * If our log shows a different fingerprint, our pipeline corrupted
 * the secret (clipboard whitespace, double-encryption, encoding
 * drift). If they match, our pipeline is fine and the issue is on
 * the IdP side (rotated secret, wrong client_id, etc.).
 */
function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

/**
 * Sidecar map keyed on the same cache key as `configCache`. Tracks
 * the chosen ClientAuth method and the IdP's advertised set so the
 * callback failure log can surface BOTH in one line — debugging
 * invalid_client without that pair is guess-and-check.
 */
const authMethodCache = new Map<
  string,
  { chosen: "client_secret_post" | "client_secret_basic" | "none"; supported: readonly string[] }
>();

/**
 * Read what `loadConfig` decided for this provider, for diagnostic
 * logging only. Returns null when the provider hasn't been resolved
 * yet (cache cleared / first request after boot).
 */
export function readAuthMethodChoice(provider: ResolvedOidcProvider): {
  chosen: "client_secret_post" | "client_secret_basic" | "none";
  supported: readonly string[];
} | null {
  return authMethodCache.get(cacheKey(provider)) ?? null;
}

async function loadConfig(provider: ResolvedOidcProvider): Promise<oidc.Configuration> {
  const key = cacheKey(provider);
  const cached = configCache.get(key);
  if (cached) return cached;

  // SSRF re-check before fetching the (admin-configured) issuer — DNS-rebind
  // defense, mirroring the PDNS request-time guard. Bounded: discovery only runs
  // on a config-cache miss, not every sign-in.
  await assertSafeOidcIssuerUrl(provider.issuerUrl);

  // First-pass discovery — gets the AS metadata. openid-client picks
  // ClientSecretPost by default whenever a client_secret is present,
  // but many IdPs (notably authentik in non-default configurations,
  // some Keycloak realms, and certain ADFS setups) accept ONLY
  // client_secret_basic at their token endpoint. We inspect the
  // advertised `token_endpoint_auth_methods_supported` and rebuild the
  // Configuration with a matching ClientAuth when post isn't on offer.
  // Without this, `invalid_client / "Client authentication failed"`
  // back from the token endpoint is the result and no amount of
  // operator-side fiddling fixes it.
  let config = await oidc.discovery(
    new URL(provider.issuerUrl),
    provider.clientId,
    provider.clientSecret,
    undefined,
    // Pin the guard-validated address into discovery AND every later request
    // openid-client makes on the resolved config (JWKS, token exchange). The
    // assignment to the Configuration persists, so the token POST carrying the
    // client_secret can't be rebound to an internal address.
    { [oidc.customFetch]: guardedOidcFetch },
  );

  const supportedMethods = config.serverMetadata().token_endpoint_auth_methods_supported ?? [];
  const hasSecret = provider.clientSecret.length > 0;
  let chosenMethod: "client_secret_post" | "client_secret_basic" | "none" = hasSecret
    ? "client_secret_post"
    : "none";

  if (supportedMethods.length > 0) {
    const supportsPost = supportedMethods.includes("client_secret_post");
    const supportsBasic = supportedMethods.includes("client_secret_basic");
    const supportsNone = supportedMethods.includes("none");

    if (hasSecret) {
      // Prefer the methods in this order: basic → post → none.
      //
      //   • client_secret_basic is the OIDC Core 1.0 § 9 default when a
      //     client doesn't specify token_endpoint_auth_method. The
      //     reference Rust `openidconnect` crate honors this default;
      //     `openid-client` v6 (JS) deviates by defaulting to post. We
      //     align with the spec + reference impls so authentik-style
      //     IdPs that strictly enforce the client's configured method
      //     (even when discovery advertises both) work out of the box.
      //
      //   • client_secret_post is the fallback when only post is on offer.
      //
      //   • none is a last resort: the AS advertises neither secret
      //     method even though we hold a secret. Most likely the
      //     operator set the client type to Public in the IdP — strip
      //     the secret and try None.
      if (supportsBasic) {
        chosenMethod = "client_secret_basic";
        config = attachGuardedFetch(
          new oidc.Configuration(
            config.serverMetadata(),
            provider.clientId,
            provider.clientSecret,
            oidc.ClientSecretBasic(provider.clientSecret),
          ),
        );
      } else if (supportsPost) {
        chosenMethod = "client_secret_post";
      } else if (supportsNone) {
        // The AS says it doesn't accept either secret method. Most
        // likely the operator set the client type to Public in the IdP
        // — strip the secret and try None.
        chosenMethod = "none";
        config = attachGuardedFetch(
          new oidc.Configuration(
            config.serverMetadata(),
            provider.clientId,
            undefined,
            oidc.None(),
          ),
        );
        logger.warn(
          {
            provider: provider.slug,
            supported: supportedMethods,
          },
          "oidc.discovery.auth-method.no-secret-accepted",
        );
      }
    } else if (!supportsNone) {
      // We have no secret but the IdP wants one. Same outcome as
      // before — leave default — but flag it so operators notice.
      logger.warn(
        {
          provider: provider.slug,
          supported: supportedMethods,
        },
        "oidc.discovery.auth-method.secret-required",
      );
    }
  }

  configCache.set(key, config);
  authMethodCache.set(key, { chosen: chosenMethod, supported: supportedMethods });
  logger.info(
    {
      provider: provider.slug,
      source: provider.source,
      issuer: provider.issuerUrl,
      auth_method: chosenMethod,
      supported_methods: supportedMethods,
      secret_len: provider.clientSecret.length,
      // Operator-side check: `echo -n "<secret>" | sha256sum | head -c 8`
      // computes the same value. Mismatch ⇒ the secret in our DB
      // isn't what the operator pasted (whitespace, encoding,
      // double-encryption, etc).
      secret_fp: secretFingerprint(provider.clientSecret),
      client_id_len: provider.clientId.length,
      client_id_fp: secretFingerprint(provider.clientId),
    },
    "oidc.discovery.loaded",
  );
  return config;
}

/**
 * Invalidate the cached discovery config for a provider — call after a row
 * update so the next request re-discovers against the new credentials.
 */
export function invalidateOidcConfigCache(provider?: ResolvedOidcProvider): void {
  if (!provider) {
    configCache.clear();
    authMethodCache.clear();
    return;
  }
  configCache.delete(cacheKey(provider));
  authMethodCache.delete(cacheKey(provider));
}

/**
 * Return the URL the user should be redirected to in order to initiate
 * authentication, plus the random `state`, PKCE `codeVerifier`, and `nonce`
 * the callback handler will need.
 *
 * The `nonce` is bound into the authorization request and echoed by the IdP
 * as a claim in the ID token; verifying it on callback (via `expectedNonce`)
 * defeats ID-token replay — a token minted for one login attempt can't be
 * injected into another, since each attempt carries its own random nonce.
 */
export async function buildAuthorizationUrl(
  provider: ResolvedOidcProvider,
  redirectUri: string,
): Promise<{ url: URL; state: string; codeVerifier: string; nonce: string }> {
  const config = await loadConfig(provider);
  const state = randomUUID();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const nonce = oidc.randomNonce();

  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: provider.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url, state, codeVerifier, nonce };
}

/**
 * Complete the OIDC flow. Verifies state, exchanges code for tokens, returns
 * the verified identity. Throws on any validation failure.
 */
export async function completeAuthorization(input: {
  provider: ResolvedOidcProvider;
  callbackUrl: URL;
  state: string;
  codeVerifier: string;
  nonce: string;
}): Promise<VerifiedIdentity> {
  let config = await loadConfig(input.provider);

  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(config, input.callbackUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.state,
      // openid-client verifies the ID token's `nonce` claim matches this
      // exactly, rejecting a replayed token issued for a different attempt.
      expectedNonce: input.nonce,
    });
  } catch (cause) {
    // The autorization code is single-use — once the token endpoint
    // rejects the request the code is dead. So we can't blindly retry
    // with a different ClientAuth and hope it works.
    //
    // BUT openid-client v6's behavior is to FIRST try our chosen method
    // and only the request body / Authorization header changes between
    // post and basic. authentik (and Keycloak in some setups) enforces
    // the per-client `token_endpoint_auth_method` value: if it's set to
    // basic but we sent post, authentik 400s with invalid_client
    // BEFORE consuming the code. The code is still valid on first
    // request only — authentik tracks consumption on success, not on
    // auth-method-mismatch failure. We rely on that to retry exactly
    // once with the other supported method.
    if (shouldRetryWithOtherAuthMethod(cause, input.provider)) {
      const newConfig = rebuildWithOtherAuthMethod(config, input.provider);
      if (newConfig) {
        logger.warn(
          {
            provider: input.provider.slug,
            retried_as: readAuthMethodChoice(input.provider)?.chosen,
          },
          "oidc.exchange.retry.auth-method",
        );
        config = newConfig;
        tokens = await oidc.authorizationCodeGrant(config, input.callbackUrl, {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
        });
      } else {
        throw cause;
      }
    } else {
      throw cause;
    }
  }

  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC: no claims returned with the token set.");

  const email = readClaimString(claims, input.provider.claimEmail);
  if (!email) {
    throw new Error(`OIDC: claim '${input.provider.claimEmail}' missing from id_token.`);
  }

  const name = readClaimString(claims, input.provider.claimName);
  const emailVerified = readClaimBool(claims, "email_verified");

  // RP-initiated logout material. `end_session_endpoint` is an
  // optional OIDC Session Management field; not every IdP advertises
  // it. When absent, logout falls back to the plain local cookie-
  // clear path. `id_token` is the raw compact JWS we just got from
  // the token endpoint — needed by the IdP as `id_token_hint` on
  // the logout redirect so it can identify which session to end.
  const asMeta = config.serverMetadata() as unknown as {
    end_session_endpoint?: unknown;
  };
  const endSessionUrl =
    typeof asMeta.end_session_endpoint === "string" ? asMeta.end_session_endpoint : null;
  const idToken =
    typeof (tokens as unknown as { id_token?: unknown }).id_token === "string"
      ? (tokens as unknown as { id_token: string }).id_token
      : null;
  // Refresh token — captured when the IdP issued one (i.e. the configured
  // scopes included `offline_access` and the IdP honoured it). Stored
  // encrypted on the session so the token-auth path can refresh the groups
  // claim at API-token use time. Null when absent — token use falls back
  // to the latest session snapshot instead.
  const refreshToken =
    typeof (tokens as unknown as { refresh_token?: unknown }).refresh_token === "string"
      ? (tokens as unknown as { refresh_token: string }).refresh_token
      : null;
  logger.info(
    {
      provider: input.provider.slug,
      endSessionUrl,
      idTokenLen: idToken?.length ?? 0,
      hasClaim: !!claims,
    },
    "oidc.logout-material.captured",
  );

  return {
    source: `oidc:${input.provider.slug}`,
    email,
    name: name ?? undefined,
    emailVerified: emailVerified ?? undefined,
    claims: claims,
    oidcLogout: {
      endSessionUrl,
      idToken,
      clientId: input.provider.clientId,
      refreshToken,
    },
  };
}

function readClaimString(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Decide whether the auth-method mismatch retry path is worth taking.
 * Yes when:
 *   • The error came from the IdP as `invalid_client` (auth method
 *     rejection — never a code-related failure).
 *   • The AS advertised BOTH secret methods. If it only advertised
 *     one, retrying with the other is guaranteed to fail too.
 *   • We have a secret to send (no-secret clients use `none` only).
 */
function shouldRetryWithOtherAuthMethod(cause: unknown, provider: ResolvedOidcProvider): boolean {
  if (!(cause instanceof Error)) return false;
  const detail = describeOidcError(cause);
  if (detail.error !== "invalid_client") return false;
  if (provider.clientSecret.length === 0) return false;
  const choice = readAuthMethodChoice(provider);
  if (!choice) return false;
  return (
    choice.supported.includes("client_secret_basic") &&
    choice.supported.includes("client_secret_post")
  );
}

/**
 * Build a new Configuration that uses the OTHER client_secret method
 * compared to the one currently cached. Also updates the sidecar
 * authMethodCache so the next failure log line reflects the swap.
 *
 * Returns null when there's no "other" method to swap to (cache miss
 * or current method isn't basic/post).
 */
function rebuildWithOtherAuthMethod(
  config: oidc.Configuration,
  provider: ResolvedOidcProvider,
): oidc.Configuration | null {
  const choice = readAuthMethodChoice(provider);
  if (!choice) return null;
  const key = cacheKey(provider);

  if (choice.chosen === "client_secret_basic") {
    const rebuilt = attachGuardedFetch(
      new oidc.Configuration(
        config.serverMetadata(),
        provider.clientId,
        provider.clientSecret,
        oidc.ClientSecretPost(provider.clientSecret),
      ),
    );
    configCache.set(key, rebuilt);
    authMethodCache.set(key, { chosen: "client_secret_post", supported: choice.supported });
    return rebuilt;
  }
  if (choice.chosen === "client_secret_post") {
    const rebuilt = attachGuardedFetch(
      new oidc.Configuration(
        config.serverMetadata(),
        provider.clientId,
        provider.clientSecret,
        oidc.ClientSecretBasic(provider.clientSecret),
      ),
    );
    configCache.set(key, rebuilt);
    authMethodCache.set(key, { chosen: "client_secret_basic", supported: choice.supported });
    return rebuilt;
  }
  return null;
}

/**
 * Extract operator-actionable fields from an openid-client / oauth4webapi
 * error so the "OIDC sign-in failed" log line carries enough to
 * diagnose without a debugger session.
 *
 * The errors surface like this in practice:
 *
 *   ResponseBodyError              — token endpoint returned a JSON
 *                                    OAuth error (invalid_grant,
 *                                    invalid_client, etc.). Most
 *                                    common; carries `error`,
 *                                    `error_description`, `status`,
 *                                    `cause` (full parsed body).
 *   AuthorizationResponseError     — the redirect carried `error=` in
 *                                    its query string (user denied
 *                                    consent, access_denied, etc.).
 *                                    `cause` is the URLSearchParams.
 *   WWWAuthenticateChallengeError  — UserInfo / introspection
 *                                    challenge; not used in our flow.
 *   Plain Error                    — discovery / JOSE failures.
 *
 * Field-name match is duck-typed so a major-version bump of
 * openid-client doesn't break logging (the structured fields are
 * stable across the v5→v6 transition).
 */
export interface OidcErrorDetail {
  /** Generic message; always present. */
  message: string;
  /** OAuth-spec error code from the IdP (e.g. "invalid_grant"). */
  error?: string;
  /** Human-readable detail from the IdP. */
  error_description?: string;
  /** HTTP status of the token endpoint response (when applicable). */
  status?: number;
  /** Library-internal code (RESPONSE_BODY_ERROR, etc.). */
  code?: string;
  /** Full parsed error body, JSON-stringified + truncated. Last-resort
   *  detail when an IdP returns a non-standard shape. */
  body?: string;
}

export function describeOidcError(err: unknown): OidcErrorDetail {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const detail: OidcErrorDetail = { message: err.message };
  const e = err as unknown as Record<string, unknown>;

  if (typeof e["error"] === "string") detail.error = e["error"];
  if (typeof e["error_description"] === "string") {
    detail.error_description = e["error_description"].slice(0, 500);
  }
  if (typeof e["status"] === "number") detail.status = e["status"];
  if (typeof e["code"] === "string") detail.code = e["code"];

  // `cause` is either a parsed JSON object (ResponseBodyError) or
  // URLSearchParams (AuthorizationResponseError). Stringify both into
  // a single inspectable field, truncated.
  const cause = e["cause"];
  if (cause instanceof URLSearchParams) {
    detail.body = cause.toString().slice(0, 500);
  } else if (cause && typeof cause === "object") {
    try {
      detail.body = JSON.stringify(cause).slice(0, 500);
    } catch {
      // unstringifiable cause — fall through.
    }
  }
  return detail;
}

// Re-exported here so callers can keep importing from a single place;
// the implementation lives in a separate pure module for testability.
export { emailDomainAllowed, resolveAllowedDomains } from "../email-domain-allowlist";

/**
 * Fetch the user's current group claim by exchanging the session's stored
 * refresh token for a new access token, then calling the IdP's userinfo
 * endpoint. Used by the token-auth path to live-recompute IdP-derived
 * permissions at API token use time.
 *
 * Returns `null` on any failure (provider missing/disabled, refresh
 * rejected by the IdP, userinfo error). The caller falls back to the
 * session-snapshot path bounded by `TOKEN_IDP_FALLBACK_TTL_SECONDS`.
 *
 * The refresh token is consumed but not rotated back into the session
 * here. Many IdPs rotate refresh tokens on every use, so holding a stale
 * token is no worse than what we already have; the staleness self-heals
 * on the user's next sign-in.
 */
export async function fetchOidcGroupsForUser(slug: string, refreshToken: string): Promise<unknown> {
  let provider: ResolvedOidcProvider | null;
  try {
    provider = await resolveOidcProvider(slug);
  } catch (err) {
    logger.warn(
      { provider: slug, err: err instanceof Error ? err.message : "unknown" },
      "oidc.recompute.resolve-failed",
    );
    return null;
  }
  if (!provider) return null;

  let config: oidc.Configuration;
  try {
    config = await loadConfig(provider);
  } catch (err) {
    logger.warn(
      { provider: slug, err: err instanceof Error ? err.message : "unknown" },
      "oidc.recompute.config-load-failed",
    );
    return null;
  }

  // Exchange refresh → access token. If the IdP rotated or revoked the
  // refresh token, this fails — the caller's fallback path handles it.
  let tokens;
  try {
    tokens = await oidc.refreshTokenGrant(config, refreshToken);
  } catch (err) {
    logger.warn(
      { provider: slug, err: err instanceof Error ? err.message : "unknown" },
      "oidc.recompute.refresh-failed",
    );
    return null;
  }

  const accessToken =
    typeof (tokens as unknown as { access_token?: unknown }).access_token === "string"
      ? (tokens as unknown as { access_token: string }).access_token
      : null;
  if (!accessToken) return null;

  // Fetch userinfo for the latest groups claim. `sub` is required by
  // openid-client v6's `fetchUserInfo`; we read it from the new tokens'
  // claims (or from the refresh response). Falling back to an empty
  // string when missing is safe — openid-client will still send the
  // bearer + parse the response.
  const claims = (tokens as unknown as { claims?: () => Record<string, unknown> }).claims?.() ?? {};
  const sub = typeof claims["sub"] === "string" ? claims["sub"] : "";

  let userinfo: Record<string, unknown>;
  try {
    userinfo = await oidc.fetchUserInfo(config, accessToken, sub);
  } catch (err) {
    logger.warn(
      { provider: slug, err: err instanceof Error ? err.message : "unknown" },
      "oidc.recompute.userinfo-failed",
    );
    return null;
  }

  return userinfo[provider.claimGroups] ?? null;
}

function readClaimBool(claims: Record<string, unknown>, key: string): boolean | null {
  const v = claims[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return null;
}
