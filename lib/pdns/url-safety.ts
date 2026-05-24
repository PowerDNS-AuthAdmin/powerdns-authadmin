/**
 * lib/pdns/url-safety.ts
 *
 * PowerDNS-flavored wrapper over the dialect-neutral SSRF guard
 * (`lib/net/url-safety.ts`). Any user-supplied PDNS `baseUrl` (from the admin
 * "Add server" form) passes through `assertSafePdnsUrl` before:
 *   - being persisted on the `pdns_servers` row, and
 *   - being requested from `lib/pdns/http.ts` (re-checked at request time as a
 *     DNS-rebinding defense).
 *
 * Policy:
 *   - `APP_PDNS_ALLOW_PRIVATE_NETWORKS` — loopback / RFC1918 / CGNAT / ULA.
 *     Default permissive in non-prod (docker-compose), strict in prod.
 *   - `APP_PDNS_ALLOW_INSECURE_HTTP` — relax the https-in-prod scheme check.
 * Link-local (incl. 169.254.169.254 cloud metadata) is always blocked.
 */

import "server-only";
import { env, isProduction } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import {
  checkOutboundUrlSafe,
  type OutboundUrlPolicy,
  type UrlSafetyResult,
} from "@/lib/net/url-safety";

export type { UrlSafetyResult };

interface AssertOptions {
  /** Force private networks allowed/denied regardless of env (tests). */
  allowPrivateNetworks?: boolean;
}

function pdnsPolicy(opts: AssertOptions): OutboundUrlPolicy {
  // Override (tests) → env → permissive in non-prod / strict in prod.
  const allowPrivateNetworks =
    opts.allowPrivateNetworks ?? env.APP_PDNS_ALLOW_PRIVATE_NETWORKS ?? !isProduction;
  return {
    allowPrivateNetworks,
    allowInsecureHttp: env.APP_PDNS_ALLOW_INSECURE_HTTP === true,
    label: "Base URL",
    insecureHttpHint:
      "Set APP_PDNS_ALLOW_INSECURE_HTTP=true to allow http:// when PDNS lives on a private network without TLS.",
    privateNetworkHint:
      "Set APP_PDNS_ALLOW_PRIVATE_NETWORKS=true to allow this in your environment.",
  };
}

/** Validate a PDNS backend URL. Returns a discriminated result. */
export async function checkPdnsUrlSafe(
  urlString: string,
  opts: AssertOptions = {},
): Promise<UrlSafetyResult> {
  return checkOutboundUrlSafe(urlString, pdnsPolicy(opts));
}

/** Throwing variant — raises `ValidationError` on failure. */
export async function assertSafePdnsUrl(
  urlString: string,
  opts: AssertOptions = {},
): Promise<void> {
  const result = await checkPdnsUrlSafe(urlString, opts);
  if (!result.safe) throw new ValidationError(result.reason);
}
