/**
 * lib/realtime/backend-status.ts
 *
 * The single source of truth for "is this backend reachable RIGHT NOW".
 *
 * Every PowerDNS read - the background poll AND any explicit refresh - records
 * the outcome here, so every page that shows reachability (the servers list
 * badge, the zones list, the server-detail header) reads ONE shared value and
 * they can never disagree. This is the live, immediate signal; the debounced
 * `backend_advisories` (the bell) sit on top of it as the anti-flap notification
 * layer. Background flapping is absorbed by the advisory debounce; a page the
 * operator is actively looking at reflects the latest observation at once.
 *
 * State lives on `globalThis` (same survives-bundle-duplication reason as the
 * zone-state + topology caches). Empty until the first observation; consumers
 * treat "unknown" as not-yet-observed, not as down.
 */

import "server-only";

export interface BackendStatus {
  /** The last read of this backend's API succeeded. */
  reachable: boolean;
  /** The failure was a 401/403 (key/ACL), not a network/transport failure. */
  authError: boolean;
  /** When this status was observed (epoch ms). */
  observedAt: number;
}

declare global {
  var __pdnsBackendStatus: Map<string, BackendStatus> | undefined;
}
const current = (): Map<string, BackendStatus> =>
  (globalThis.__pdnsBackendStatus ??= new Map<string, BackendStatus>());

/** Record a backend read outcome. Called by every poll + explicit refresh. */
export function recordBackendStatus(
  backendId: string,
  reachable: boolean,
  authError: boolean,
): void {
  current().set(backendId, { reachable, authError, observedAt: Date.now() });
}

/** The live status for one backend, or null if never observed. */
export function getBackendStatus(backendId: string): BackendStatus | null {
  return current().get(backendId) ?? null;
}

/** "down" | "auth" | null(=reachable / not yet observed) - for status badges. */
export function backendUnreachability(backendId: string): "down" | "auth" | null {
  const s = current().get(backendId);
  if (!s || s.reachable) return null;
  return s.authError ? "auth" : "down";
}

/** Drop a backend's status (on delete). Safe when absent. */
export function forgetBackendStatus(backendId: string): void {
  current().delete(backendId);
}
