/**
 * lib/net/host.ts
 *
 * Bare-host extraction shared by the topology matcher (server) and the
 * add-server form (client) - both need "the host of this API URL" with IPv6
 * brackets stripped and case normalized. Pure (no `server-only`, no I/O) so both
 * sides import the one implementation instead of keeping divergent copies.
 */

/**
 * The bare, lowercase host of a URL - scheme, port, path stripped and IPv6
 * `[...]` brackets removed. Returns `null` when the input doesn't parse.
 */
export function hostFromUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h ? h.replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}
