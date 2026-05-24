/**
 * lib/realtime/backend-gateway.ts
 *
 * THE common entry point for talking to a PowerDNS backend. Every read AND write
 * — pages, API routes, cross-server coordination — gets its client from here
 * instead of calling `getPdnsClientForRow` directly, so:
 *
 *   • the live reachability store (`backend-status`) is updated from EVERY
 *     interaction, not just the background poll — a failed write or a config
 *     read on a dead backend immediately moves the single source of truth; and
 *   • there is exactly one place that turns a backend row into a client.
 *
 * `getBackendGateway(backend)` returns the backend's `PdnsClient` wrapped so each
 * async method records the outcome on settle and rethrows the typed error
 * unchanged (HTTP routes still map it via `errorResponse`). Sync members
 * (`serverSlug`, `supports`, …) pass through untouched.
 *
 * Reachability classification: a RESPONSE — even a 4xx semantic rejection
 * (404/409/422 on a write) — proves the backend is reachable; only a
 * transport/5xx failure (`PdnsUpstreamError`) is "unreachable", and a 401/403
 * (`PdnsAuthError`) is "auth". An unexpected non-PDNS error leaves the status
 * untouched (cause unknown).
 *
 * The broker internals (the poll + `backend-health`) record status directly —
 * they need the auth flag inline for the advisory eval — so they stay below this
 * facade rather than calling it.
 */

import "server-only";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsClient } from "@/lib/pdns/client";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { PdnsAuthError, PdnsError, PdnsUpstreamError } from "@/lib/pdns/errors";
import { recordBackendStatus } from "./backend-status";

function recordFailure(backendId: string, err: unknown): void {
  if (err instanceof PdnsAuthError) recordBackendStatus(backendId, false, true);
  else if (err instanceof PdnsUpstreamError) recordBackendStatus(backendId, false, false);
  else if (err instanceof PdnsError) recordBackendStatus(backendId, true, false); // answered, semantic reject
  // non-PDNS error → unknown cause, leave status untouched
}

export function getBackendGateway(backend: PdnsServer): PdnsClient {
  const client = getPdnsClientForRow(backend);
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out instanceof Promise) {
          return (out as Promise<unknown>).then(
            (r): unknown => {
              recordBackendStatus(backend.id, true, false);
              return r;
            },
            (err: unknown) => {
              recordFailure(backend.id, err);
              throw err;
            },
          );
        }
        return out; // sync member (getter / supports()) — untouched
      };
    },
  });
}
