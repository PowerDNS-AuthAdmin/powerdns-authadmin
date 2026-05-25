/**
 * lib/net/pinned-fetch.ts
 *
 * DNS-rebinding-proof outbound fetch. The SSRF guard (`checkOutboundUrlSafe`,
 * via the per-feature wrappers) resolves a host and classifies every address it
 * gets back. But a `fetch`/undici call done afterwards re-resolves the hostname
 * independently — a TOCTOU window an attacker exploits with a 0-TTL record that
 * answers the guard's lookup with a public IP and undici's connect with a
 * private/loopback/metadata IP.
 *
 * This module closes that window for ANY outbound URL the way `lib/pdns/http.ts`
 * already does for the PDNS API: it PINS one of the guard-validated addresses
 * into a single-use undici `Agent`'s `connect.lookup`, so the peer undici
 * connects to is byte-for-byte the address the guard classified as safe. The
 * original hostname still flows as Host header + TLS SNI; only the address
 * resolution is overridden. The dispatcher is torn down after the request — it
 * carries this request's pinned address and must never be reused for a hostname
 * that may now resolve elsewhere.
 *
 * Two consumers:
 *   - `lib/pdns/http.ts` — the PDNS API transport (uses {@link buildPinnedDispatcher}).
 *   - `lib/auth/providers/oidc.ts` / `oidc-probe.ts` — OIDC discovery + the
 *     token-exchange POST that carries the `client_secret` (use
 *     {@link makeGuardedFetch}, wired through openid-client's `customFetch`).
 */

import "server-only";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Result shape the guard must return: the dialect-neutral
 * {@link import("./url-safety").UrlSafetyResult}. `safe: true` carries the list
 * of validated addresses to pin from; `safe: false` carries a user-facing
 * reason. Re-declared structurally (not imported) so this module stays free of
 * a hard dependency on the guard module — any callable matching this contract
 * works.
 */
export type GuardResult = { safe: true; addresses: string[] } | { safe: false; reason: string };

/** A guard callable: validates + resolves a URL, returns the pinnable result. */
export type UrlGuard = (url: string) => Promise<GuardResult>;

/**
 * Build a single-use undici dispatcher whose `connect.lookup` returns one of
 * the guard-validated addresses instead of doing its own DNS resolution — so
 * the connected peer is byte-for-byte an IP the guard classified as safe. This
 * closes the DNS-rebinding window between the guard's lookup and undici's
 * connect (an attacker-controlled host returning a public IP to the guard and a
 * private/loopback IP to undici with a 0-TTL record). The original hostname
 * still flows to undici as Host header + TLS SNI; only the address resolution
 * is overridden.
 *
 * `agentOptions` lets a caller inherit a shared Agent profile (e.g. the PDNS
 * pool's TLS/H2/timeout options) so the only difference from the pooled
 * dispatcher is the pinned `connect.lookup`. The Agent is single-use — close it
 * once the request settles (see {@link makeGuardedFetch}).
 */
export function buildPinnedDispatcher(
  addresses: string[],
  agentOptions: Agent.Options = {},
): Agent {
  // Prefer an IPv4 address when available — matches the OS resolver's common
  // default and avoids surprising IPv6-only connects in IPv4-only networks.
  // Any address in the list already passed the guard, so the choice is purely
  // about reachability, not safety.
  const pinned = addresses.find((addr) => isIP(addr) === 4) ?? addresses[0];
  const family = pinned !== undefined ? isIP(pinned) : 0;

  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (pinned === undefined) {
      callback(new Error("no validated address to pin"), "", 0);
      return;
    }
    // Node's net.connect uses Happy Eyeballs (`autoSelectFamily`, default-on in
    // Node 20+), which calls `lookup` with `{ all: true }` and expects an ARRAY
    // of { address, family }; other callers use the single (err, address,
    // family) form. Support both — handing the single form to an all:true caller
    // leaves the address `undefined`, so the connect fails with "Invalid IP
    // address: undefined" (the regression real undici hits but a direct unit
    // call does not).
    if (options.all === true) {
      callback(null, [{ address: pinned, family }]);
    } else {
      callback(null, pinned, family);
    }
  };

  return new Agent({ ...agentOptions, connect: { lookup } });
}

/** Tunables for {@link makeGuardedFetch}. */
export interface GuardedFetchOptions {
  /**
   * undici Agent options the pinned dispatcher inherits (TLS/H2/timeouts). The
   * `connect.lookup` is always overridden with the pinned lookup regardless of
   * what's passed here.
   */
  agentOptions?: Agent.Options;
  /**
   * Map a guard rejection into the thrown error. Defaults to a generic
   * `Error`. PDNS/OIDC callers pass a domain error factory so the rejection
   * surfaces as their normal "transport"/upstream failure.
   */
  onUnsafe?: (reason: string) => Error;
}

/**
 * Build a `fetch`-compatible function that, for every call:
 *   1. runs `guard(url)` — which resolves + validates the host;
 *   2. rejects (throwing `onUnsafe(reason)`) when the current resolution lands
 *      in a blocked range — the request never fires;
 *   3. otherwise pins a guard-validated address into a single-use dispatcher
 *      and issues the request through it, forcing `redirect: "error"` so a
 *      hostile endpoint can't 3xx the connection to an unvalidated internal
 *      address (the guard only ever checked the original URL);
 *   4. tears the dispatcher down once the request settles.
 *
 * The returned function matches the Fetch API surface openid-client's
 * `customFetch` expects: `(url, options) => Promise<Response>`. It accepts a
 * `URL`/`Request`/string `input` and standard `RequestInit`; only `redirect`,
 * `dispatcher`, and the host pinning are imposed — everything else (method,
 * headers, body, signal) flows through untouched.
 */
export function makeGuardedFetch(
  guard: UrlGuard,
  options: GuardedFetchOptions = {},
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();

    const safety = await guard(url);
    if (!safety.safe) {
      const factory =
        options.onUnsafe ?? ((reason) => new Error(`Refusing to call unsafe URL: ${reason}`));
      throw factory(safety.reason);
    }

    // `addresses` is non-empty: a guard that returns `safe: true` with an empty
    // address list is the `treatUnresolvableAsSafe` path, which would leave
    // nothing to pin. Callers that use that policy must pre-resolve; the OIDC
    // guard here resolves (issuer is being fetched now), so this holds.
    const dispatcher = buildPinnedDispatcher(safety.addresses, options.agentOptions);

    try {
      return (await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        // SSRF guard: never follow redirects. The guard validated only the
        // original URL; a (compromised or hostile) endpoint returning a 3xx to
        // an internal address would otherwise be followed, bypassing the
        // allowlist. Override whatever the caller (openid-client passes
        // "manual") set — fail loud on any redirect.
        redirect: "error",
        dispatcher,
      })) as unknown as Response;
    } finally {
      // The pinned dispatcher is single-use: it carries this request's
      // validated address and must not be reused for a hostname that may now
      // resolve elsewhere. `close()` waits for in-flight work; fire-and-forget
      // — a close failure is irrelevant to the caller.
      void dispatcher.close().catch(() => undefined);
    }
  };
}
