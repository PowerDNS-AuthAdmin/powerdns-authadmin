/**
 * lib/auth/webauthn/config.ts
 *
 * Resolves the four bits of WebAuthn configuration the server-side ceremony
 * helpers (`@simplewebauthn/server`) need on every call:
 *
 *   - `rpId`         - Relying-Party identifier. A bare hostname; MUST equal
 *                       (or be a registrable-domain ancestor of) the `origin`
 *                       the browser reaches us on. Derived from APP_URL's
 *                       hostname by default, override via WEBAUTHN_RP_ID for
 *                       apex/sub-domain sharing.
 *   - `rpName`       - display name shown by browsers/OS at the prompt.
 *                       Pulled at request time from `settings.site_name`
 *                       with a fallback literal when settings are
 *                       unreachable.
 *   - `expectedOrigin` - list of origins the verifier accepts during
 *                       verification. Always includes the canonical
 *                       `https://<rpId>` and the `APP_URL` origin. When
 *                       `WEBAUTHN_ALLOW_INSECURE_ORIGINS=true`, also
 *                       includes the `http://<rpId>` and any local-dev
 *                       origins the operator may hit.
 *   - `userVerification` / `attestation` - policy controls, passed
 *                       through to ceremony options.
 *
 * Pure and unit-tested. The settings.site_name lookup is the only
 * impure surface; pass the resolved siteName in from the caller so the
 * test suite can pin a deterministic value.
 */

export interface ResolvedWebauthnConfig {
  /** Relying-Party identifier (bare hostname). */
  rpId: string;
  /** Display name shown at the platform prompt. */
  rpName: string;
  /** Acceptable origins for assertion/registration verification. */
  expectedOrigins: string[];
  /** User-verification policy. */
  userVerification: "required" | "preferred" | "discouraged";
  /** Attestation conveyance preference. */
  attestation: "none" | "direct";
}

export interface ResolveWebauthnConfigInput {
  appUrl: string;
  /** From env.WEBAUTHN_RP_ID - bare host, or undefined to derive from APP_URL. */
  rpIdOverride: string | undefined;
  /** From env.WEBAUTHN_RP_NAME - explicit override; takes precedence over siteName. */
  rpNameOverride: string | undefined;
  /** Resolved from `settings.site_name` by the caller; null when unavailable. */
  siteName: string | null;
  userVerification: "required" | "preferred" | "discouraged";
  attestation: "none" | "direct";
  allowInsecureOrigins: boolean;
}

const RP_NAME_FALLBACK = "PowerDNS-AuthAdmin";

/**
 * Pure resolver. The caller assembles inputs (env + DB settings) and gets
 * back the shape `@simplewebauthn/server` needs.
 */
export function resolveWebauthnConfig(input: ResolveWebauthnConfigInput): ResolvedWebauthnConfig {
  const appOrigin = new URL(input.appUrl).origin;
  const appHost = new URL(input.appUrl).hostname;

  // `||` here is intentional, not `??`: we want the empty-string overrides
  // to also fall through to the next candidate (an override pulled from an
  // env var with `WEBAUTHN_RP_ID=` would otherwise win as ""). Adjacent
  // lint-rule suppression rather than refactoring the falsy-string semantics.
  const rpId =
    (input.rpIdOverride?.trim() !== undefined && input.rpIdOverride.trim() !== ""
      ? input.rpIdOverride.trim()
      : null) ?? appHost;
  const rpName =
    (input.rpNameOverride?.trim() !== undefined && input.rpNameOverride.trim() !== ""
      ? input.rpNameOverride.trim()
      : null) ??
    (input.siteName?.trim() !== undefined && input.siteName.trim() !== ""
      ? input.siteName.trim()
      : null) ??
    RP_NAME_FALLBACK;

  // Browsers verify the assertion's `origin` against this list. We MUST
  // include the canonical APP_URL origin (the typical case) and the
  // `https://<rpId>` form (when an operator overrode RP ID to e.g. a
  // parent domain). When the insecure-origins flag is on, also accept
  // the `http://<rpId>` form so LAN-dev (no TLS) works.
  const origins = new Set<string>([appOrigin, `https://${rpId}`]);
  if (input.allowInsecureOrigins) {
    origins.add(`http://${rpId}`);
    // The Next.js dev server also serves on localhost regardless of host
    // configuration - keep that working without forcing operators to
    // remember a separate env var.
    origins.add("http://localhost:3000");
  }

  return {
    rpId,
    rpName,
    expectedOrigins: Array.from(origins),
    userVerification: input.userVerification,
    attestation: input.attestation,
  };
}
