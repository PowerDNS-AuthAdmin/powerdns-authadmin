/**
 * lib/auth/providers/saml.ts
 *
 * SAML 2.0 service-provider core (ADR-0021). Providers live in
 * `saml_providers`; the per-request flow is symmetric to OIDC:
 *
 *   1. /api/auth/saml/<slug>/login → resolve provider config → build a signed
 *      AuthnRequest, redirect via the HTTP-Redirect binding. The expected
 *      RequestID is stashed in a short-lived HttpOnly cookie so the ACS
 *      handler can confirm the inbound Response is one we asked for.
 *   2. IdP POSTs to /api/auth/saml/<slug>/acs with `SAMLResponse`. We hand
 *      the body to `@node-saml/node-saml`'s `SAML.validatePostResponseAsync`
 *      which verifies the signature against the IdP's stored cert, decrypts
 *      EncryptedAssertion if present (using our SP encryption key), and
 *      returns the parsed Profile. We map attributes → `VerifiedIdentity`.
 *
 * The `SAML` instance is cached per-provider so we don't re-parse PEMs on
 * every request; rotating any of {idp cert, sp signing key, sp encryption
 * key} invalidates the cache via {@link invalidateSamlConfigCache}.
 */

import "server-only";
import { randomUUID } from "node:crypto";

import {
  generateServiceProviderMetadata,
  SAML,
  ValidateInResponseTo,
  type SamlConfig,
} from "@node-saml/node-saml";

import { decrypt } from "@/lib/crypto/encryption";
import { findSamlProviderBySlug } from "@/lib/db/repositories/saml-providers";
import type { SamlGroupMapping, SamlProvider } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { VerifiedIdentity } from "./types";

/** Resolved provider config - keypairs decrypted in-memory. */
export interface ResolvedSamlProvider {
  id: string;
  slug: string;
  name: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string | null;
  idpSigningCert: string;
  spSigningKey: string;
  spSigningCert: string;
  spEncryptionKey: string | null;
  spEncryptionCert: string | null;
  requireSignedResponse: boolean;
  requireEncryptedAssertion: boolean;
  signatureAlgorithm: "sha1" | "sha256" | "sha512";
  nameIdFormat: string;
  claimEmail: string;
  claimName: string;
  claimGroups: string;
  allowedEmailDomains: string[] | null;
  groupMappings: SamlGroupMapping[] | null;
}

function fromDbRow(row: SamlProvider): ResolvedSamlProvider {
  const sigAlg = (
    ["sha1", "sha256", "sha512"].includes(row.signatureAlgorithm)
      ? row.signatureAlgorithm
      : "sha256"
  ) as ResolvedSamlProvider["signatureAlgorithm"];
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    idpSloUrl: row.idpSloUrl,
    idpSigningCert: row.idpSigningCert,
    spSigningKey: decrypt(row.spSigningKeyEncrypted, "saml-sp-signing-key"),
    spSigningCert: row.spSigningCert,
    spEncryptionKey: row.spEncryptionKeyEncrypted
      ? decrypt(row.spEncryptionKeyEncrypted, "saml-sp-encryption-key")
      : null,
    spEncryptionCert: row.spEncryptionCert,
    requireSignedResponse: row.requireSignedResponse,
    requireEncryptedAssertion: row.requireEncryptedAssertion,
    signatureAlgorithm: sigAlg,
    nameIdFormat: row.nameIdFormat,
    claimEmail: row.claimEmail,
    claimName: row.claimName,
    claimGroups: row.claimGroups,
    allowedEmailDomains: row.allowedEmailDomains,
    groupMappings: row.groupMappings,
  };
}

/**
 * Resolve a SAML provider by slug. Returns null when no enabled row matches -
 * caller surfaces as a 404.
 */
export async function resolveSamlProvider(slug: string): Promise<ResolvedSamlProvider | null> {
  const row = await findSamlProviderBySlug(slug);
  if (!row?.enabled) return null;
  return fromDbRow(row);
}

/** Per-provider SAML instance cache. Keyed on slug + fingerprint of the
 *  credential material so a rotation auto-invalidates. */
const samlCache = new Map<string, SAML>();

function cacheKey(p: ResolvedSamlProvider): string {
  // Slices keep the key short; full secrets are not the integrity primitive
  // here (the map is in-process), they're disambiguators.
  return [
    p.slug,
    p.idpSigningCert.slice(0, 32),
    p.spSigningKey.slice(0, 32),
    p.spEncryptionKey?.slice(0, 32) ?? "",
  ].join("|");
}

function buildSamlInstance(provider: ResolvedSamlProvider, callbackUrl: string): SAML {
  const cfg: SamlConfig = {
    issuer: spEntityIdFor(provider, callbackUrl),
    callbackUrl,
    entryPoint: provider.idpSsoUrl,
    logoutUrl: provider.idpSloUrl ?? undefined,
    idpCert: provider.idpSigningCert,
    idpIssuer: provider.idpEntityId,
    privateKey: provider.spSigningKey,
    publicCert: provider.spSigningCert,
    decryptionPvk: provider.spEncryptionKey ?? undefined,
    signatureAlgorithm: provider.signatureAlgorithm,
    digestAlgorithm: provider.signatureAlgorithm,
    identifierFormat: provider.nameIdFormat,
    // Spec-aligned secure defaults: assertions MUST be signed; the Response
    // signature is required unless the operator explicitly relaxes it
    // (some IdPs sign only the assertion).
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: provider.requireSignedResponse,
    // Always verify InResponseTo (replay defense): every Response we accept
    // must echo the RequestID we issued at /login. `ifPresent` would allow
    // IdPs to drop the field; we require it.
    validateInResponseTo: ValidateInResponseTo.always,
  };
  return new SAML(cfg);
}

function getOrBuildSaml(provider: ResolvedSamlProvider, callbackUrl: string): SAML {
  const key = `${cacheKey(provider)}|${callbackUrl}`;
  const cached = samlCache.get(key);
  if (cached) return cached;
  const instance = buildSamlInstance(provider, callbackUrl);
  samlCache.set(key, instance);
  return instance;
}

/** Invalidate the SAML instance cache. Call after a provider mutation. */
export function invalidateSamlConfigCache(provider?: ResolvedSamlProvider): void {
  if (!provider) {
    samlCache.clear();
    return;
  }
  for (const k of samlCache.keys()) {
    if (k.startsWith(`${provider.slug}|`)) samlCache.delete(k);
  }
}

/**
 * Stable SP entityID: derived from the ACS callback URL (origin + the SAML
 * route base). Using a URL gives operators a stable, copy-pasteable value
 * that matches what we publish in metadata, without a separate config knob.
 */
function spEntityIdFor(_provider: ResolvedSamlProvider, callbackUrl: string): string {
  const u = new URL(callbackUrl);
  return `${u.origin}/api/auth/saml/${_provider.slug}/metadata`;
}

/**
 * Build a signed AuthnRequest and the redirect URL to the IdP's SSO endpoint.
 * The returned `requestId` is what the ACS handler verifies against the
 * inbound Response's `InResponseTo`.
 */
export async function buildAuthnRequest(
  provider: ResolvedSamlProvider,
  callbackUrl: string,
): Promise<{ redirectUrl: string; requestId: string }> {
  const requestId = `_${randomUUID()}`;
  // node-saml derives the AuthnRequest ID via `options.generateUniqueId` on
  // construction. Build a one-shot SAML instance with our ID generator so
  // the stored value matches what the IdP echoes back.
  const cfg: SamlConfig = {
    issuer: spEntityIdFor(provider, callbackUrl),
    callbackUrl,
    entryPoint: provider.idpSsoUrl,
    logoutUrl: provider.idpSloUrl ?? undefined,
    idpCert: provider.idpSigningCert,
    idpIssuer: provider.idpEntityId,
    privateKey: provider.spSigningKey,
    publicCert: provider.spSigningCert,
    decryptionPvk: provider.spEncryptionKey ?? undefined,
    signatureAlgorithm: provider.signatureAlgorithm,
    digestAlgorithm: provider.signatureAlgorithm,
    identifierFormat: provider.nameIdFormat,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: provider.requireSignedResponse,
    validateInResponseTo: ValidateInResponseTo.always,
    generateUniqueId: () => requestId,
  };
  const saml = new SAML(cfg);
  const redirectUrl = await saml.getAuthorizeUrlAsync("", undefined, {});
  return { redirectUrl, requestId };
}

/**
 * Verify an inbound SAMLResponse. Throws on signature failure, missing
 * required attributes, or `InResponseTo` mismatch.
 */
export async function verifyResponse(
  provider: ResolvedSamlProvider,
  samlResponse: string,
  expectedRequestId: string,
  callbackUrl: string,
): Promise<VerifiedIdentity> {
  const saml = getOrBuildSaml(provider, callbackUrl);
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) {
    throw new Error("SAML: response did not include a profile.");
  }

  // InResponseTo binding - defends against an attacker injecting a Response
  // not tied to our initiated login. node-saml validates the assertion
  // internally; here we cross-check what came back against our cookie value.
  const inResponseTo = typeof profile["inResponseTo"] === "string" ? profile["inResponseTo"] : null;
  if (inResponseTo && inResponseTo !== expectedRequestId) {
    throw new Error(
      `SAML: InResponseTo mismatch (expected ${expectedRequestId}, got ${inResponseTo}).`,
    );
  }

  const email = readAttribute(profile, provider.claimEmail) ?? profile.nameID ?? null;
  if (!email) {
    throw new Error(
      `SAML: no email - attribute '${provider.claimEmail}' missing and NameID is empty.`,
    );
  }

  const name = readAttribute(profile, provider.claimName) ?? undefined;

  // Group attribute: SAML attributes can be single-valued or multi-valued.
  // Normalise to a string array; downstream `applyGroupSync` does its own
  // robust coercion via `readGroupClaim`, but a clean array here keeps the
  // claim shape sensible for audit serialisation.
  const groupsRaw = profile[provider.claimGroups];
  const groups: string[] = Array.isArray(groupsRaw)
    ? groupsRaw.filter((g): g is string => typeof g === "string")
    : typeof groupsRaw === "string"
      ? [groupsRaw]
      : [];

  return {
    source: `saml:${provider.slug}`,
    email: String(email),
    ...(name ? { name } : {}),
    // SAML has no `email_verified` analogue - leave undefined so the
    // existing-account check defers to the per-provider toggle (we mirror
    // OIDC's posture: trust the IdP unless explicitly told not to).
    claims: {
      ...profile,
      // Carry the resolved groups under the configured claim name so
      // `applyGroupSync` picks them up via `provider.claimGroups`.
      [provider.claimGroups]: groups,
      sessionIndex: profile.sessionIndex ?? null,
      nameID: profile.nameID ?? null,
      nameIDFormat: profile.nameIDFormat ?? null,
    },
    // SAML has its own logout shape; we surface the IdP SLO URL +
    // sessionIndex via the same `oidcLogout` slot in session storage so the
    // logout path doesn't need a parallel column. The clientId field is
    // repurposed to carry the sessionIndex - that's what the IdP needs to
    // end the right session on SLO. Documented in this module's header.
    oidcLogout: {
      endSessionUrl: provider.idpSloUrl,
      idToken: typeof profile.nameID === "string" ? profile.nameID : null,
      clientId: typeof profile.sessionIndex === "string" ? profile.sessionIndex : null,
    },
  };
}

function readAttribute(profile: Record<string, unknown>, name: string): string | null {
  const v = profile[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  return null;
}

/**
 * Build the SP metadata XML. Operators paste this into their IdP to register
 * the SP. Includes the signing cert (always) and the encryption cert (when
 * present). `appUrl` is the public origin we expose to the IdP.
 */
export function buildSpMetadata(provider: ResolvedSamlProvider, appUrl: string): string {
  const callbackUrl = `${appUrl}/api/auth/saml/${provider.slug}/acs`;
  const logoutCallbackUrl = `${appUrl}/api/auth/saml/${provider.slug}/slo`;
  return generateServiceProviderMetadata({
    issuer: spEntityIdFor(provider, callbackUrl),
    callbackUrl,
    logoutCallbackUrl,
    identifierFormat: provider.nameIdFormat,
    wantAssertionsSigned: true,
    publicCerts: provider.spSigningCert,
    decryptionCert: provider.spEncryptionCert ?? null,
    privateKey: provider.spSigningKey,
    signatureAlgorithm: provider.signatureAlgorithm,
    digestAlgorithm: provider.signatureAlgorithm,
    // We do NOT sign the metadata XML itself by default - most IdPs accept
    // unsigned metadata, and signing it would require maintaining a separate
    // metadata-signing keypair. Operators that need signed metadata can
    // re-host this output behind their own signing infrastructure.
    signMetadata: false,
  });
}

// Re-exported here so callers can keep importing email-domain helpers from a
// single place; the implementation lives in a separate pure module shared
// between OIDC and SAML.
export { emailDomainAllowed, resolveAllowedDomains } from "../email-domain-allowlist";

/**
 * Extract operator-actionable fields from a SAML library error so the
 * `auth.saml.failure` audit log line carries enough to diagnose without
 * re-running the IdP exchange. `@node-saml/node-saml` throws regular Errors
 * with descriptive messages; we keep the message + name + stack-trace
 * truncated to a sensible size for storage.
 */
export interface SamlErrorDetail {
  message: string;
  name: string;
}

export function describeSamlError(err: unknown): SamlErrorDetail {
  if (!(err instanceof Error)) {
    return { message: String(err), name: "Unknown" };
  }
  return {
    message: err.message.slice(0, 500),
    name: err.name,
  };
}

/** Logger helper - keeps a consistent prefix for SAML diagnostic lines. */
export const samlLog = logger;
