/**
 * lib/auth/providers/oidc-url-safety.ts
 *
 * OIDC-flavored wrapper over the dialect-neutral SSRF guard
 * (`lib/net/url-safety.ts`). The OIDC issuer URL is operator-supplied and
 * fetched server-side — at config time (the `/test` probe), and at sign-in time
 * (openid-client discovery, reachable through the unauthenticated initiate
 * flow). So it must pass the same guard the PDNS base URL does, otherwise an
 * `oidc.manage` operator could point the issuer at 169.254.169.254 (cloud
 * metadata) or an internal host. Call `assertSafeOidcIssuerUrl` before persisting
 * the issuer and before any probe/discovery fetch.
 *
 * Policy mirrors the PDNS pair:
 *   - `APP_OIDC_ALLOW_PRIVATE_NETWORKS` — loopback / RFC1918 / ULA (default
 *     permissive in non-prod, strict in prod).
 *   - `APP_OIDC_ALLOW_INSECURE_HTTP` — relax the https-in-prod scheme check.
 * Link-local / cloud-metadata is always blocked.
 */

import "server-only";
import { env, isProduction } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import {
  checkOutboundUrlSafe,
  type OutboundUrlPolicy,
  type UrlSafetyResult,
} from "@/lib/net/url-safety";

function oidcPolicy(): OutboundUrlPolicy {
  const allowPrivateNetworks = env.APP_OIDC_ALLOW_PRIVATE_NETWORKS ?? !isProduction;
  return {
    allowPrivateNetworks,
    allowInsecureHttp: env.APP_OIDC_ALLOW_INSECURE_HTTP === true,
    // An issuer that doesn't resolve isn't an SSRF target. Allow storing it
    // (config can precede the IdP's DNS); discovery/token fetches re-run this
    // guard, so the only thing rejected here is an issuer that resolves to a
    // blocked address — never a typo'd or not-yet-live hostname.
    treatUnresolvableAsSafe: true,
    label: "Issuer URL",
    insecureHttpHint:
      "Set APP_OIDC_ALLOW_INSECURE_HTTP=true to allow http:// for an internal IdP without TLS.",
    privateNetworkHint:
      "Set APP_OIDC_ALLOW_PRIVATE_NETWORKS=true to allow this in your environment.",
  };
}

/** Validate an OIDC issuer URL against the SSRF policy. */
export async function checkOidcIssuerUrlSafe(urlString: string): Promise<UrlSafetyResult> {
  return checkOutboundUrlSafe(urlString, oidcPolicy());
}

/** Throwing variant — raises `ValidationError` on failure. */
export async function assertSafeOidcIssuerUrl(urlString: string): Promise<void> {
  const result = await checkOidcIssuerUrlSafe(urlString);
  if (!result.safe) throw new ValidationError(result.reason);
}
