/**
 * lib/pdns/dispatcher.ts
 *
 * undici Agent configuration for every PDNS-facing request. The options are:
 *
 *   - **Negotiate HTTP/2 via ALPN** (`allowH2: true`). Some upstream PDNS
 *     deployments live behind a Cloudflare / nginx / Envoy front that
 *     advertises H2 only; Node's default fetch only speaks H1.1 and gets
 *     `UND_ERR_SOCKET other side closed` from such servers. With allowH2 the
 *     client offers both H2 and H1.1 in ALPN; the server picks. Pure-H1
 *     servers keep working.
 *
 *   - **Keep-alive** with a per-origin connection pool, so repeated calls to
 *     the same PDNS backend reuse a TLS session and an H2 stream.
 *
 *   - **Generous per-request timeouts** at the dispatcher level. The client's
 *     own `AbortController` is the authoritative timeout — these are belt-
 *     and-braces.
 *
 * `http.ts` builds a per-request Agent from {@link PDNS_AGENT_OPTIONS} with a
 * pinned `connect.lookup` (DNS-rebinding defense), so the long-lived shared
 * Agent from {@link pdnsDispatcher} is not on the live request path; it remains
 * for callers that want a pooled dispatcher without per-request address pinning.
 */

import "server-only";
import { Agent } from "undici";

let dispatcher: Agent | null = null;

/**
 * Shared timeout/protocol options for every PDNS-facing Agent. Exported so the
 * per-request DNS-rebinding-pinned Agent in `http.ts` inherits the exact same
 * TLS/H2 negotiation and timeout behavior as the shared pool — the only
 * difference between the two is the pinned `connect.lookup`.
 */
export const PDNS_AGENT_OPTIONS: Agent.Options = {
  allowH2: true,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  connectTimeout: 10_000,
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
};

/**
 * Lazily build the shared Agent on first use. Lazy because constructing it at
 * module-load time fires before env validation in some test scenarios.
 */
export function pdnsDispatcher(): Agent {
  dispatcher ??= new Agent(PDNS_AGENT_OPTIONS);
  return dispatcher;
}
