/**
 * lib/pdns/dispatcher.ts
 *
 * Shared undici Agent used by every PdnsClient instance. Configured to:
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
 * One Agent serves every backend; undici's pool keys by origin so this is
 * still per-host pooling under the hood.
 */

import "server-only";
import { Agent } from "undici";

let dispatcher: Agent | null = null;

/**
 * Lazily build the shared Agent on first use. Lazy because constructing it at
 * module-load time fires before env validation in some test scenarios.
 */
export function pdnsDispatcher(): Agent {
  dispatcher ??= new Agent({
    allowH2: true,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 600_000,
    connectTimeout: 10_000,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  return dispatcher;
}
