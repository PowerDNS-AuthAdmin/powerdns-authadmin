/**
 * lib/pdns/daemon-config-cache.ts
 *
 * Short-lived cache of each backend's display-safe `/config` rows. Written by
 * the broker's daemon-meta probe (`probeDaemonMeta`, every 60 s poll + explicit
 * refresh) and read by the server-detail page — so that page renders the daemon
 * settings from the shared store instead of making its own live PDNS call. Same
 * single-source-of-truth + survives-bundle-duplication pattern as the zone-state
 * cache.
 *
 * Only ever holds the allowlisted, secret-stripped rows from `safeConfigSettings`
 * — never the raw config — so nothing secret-shaped lands in this store.
 */

import "server-only";
import type { SafeConfigRow } from "./config-advice";

const TTL_MS = 5 * 60_000;

interface Entry {
  fetchedAt: number;
  rows: SafeConfigRow[];
}

declare global {
  var __pdnsDaemonConfigCache: Map<string, Entry> | undefined;
}
const cache = (): Map<string, Entry> =>
  (globalThis.__pdnsDaemonConfigCache ??= new Map<string, Entry>());

export function writeDaemonConfig(backendId: string, rows: SafeConfigRow[]): void {
  cache().set(backendId, { fetchedAt: Date.now(), rows });
}

/** Display-safe config rows for a backend, or null when cold/stale. */
export function readDaemonConfig(backendId: string): SafeConfigRow[] | null {
  const entry = cache().get(backendId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry.rows;
}
