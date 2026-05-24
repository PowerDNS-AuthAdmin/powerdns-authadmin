/**
 * lib/pdns/version.ts
 *
 * Parse a PDNS version string into a comparable triple and derive capability
 * flags. Versions that fail to parse fall back to a conservative "no
 * optional capabilities" snapshot — the app degrades to the lowest-common-
 * denominator surface rather than guessing.
 */

import "server-only";
import type { PdnsVersionCache } from "./types";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** Best-effort parse — accepts a leading semver triple, ignores any suffix. */
function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare two parsed versions. Returns negative / 0 / positive. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** True if `a >= b`. */
function gte(a: ParsedVersion, b: ParsedVersion): boolean {
  return compareVersions(a, b) >= 0;
}

/**
 * Build a fresh capability snapshot from a server-info response. The result
 * is what gets cached on the `pdns_servers.version_cache` column.
 *
 * Capability cutoffs:
 *   - EXTEND/PRUNE: PDNS ≥ 4.9.12 *or* ≥ 5.0.2 ().
 *   - Catalog zones: PDNS ≥ 4.7.
 *   - Views/Networks: PDNS ≥ 5.0.
 *   - TSIG API (import/get-secret): PDNS ≥ 4.1.
 */
export function buildVersionCache(rawVersion: string, serverId: string): PdnsVersionCache {
  const parsed = parseVersion(rawVersion) ?? { major: 0, minor: 0, patch: 0 };
  const supportsExtendPrune =
    (parsed.major === 4 && (parsed.minor > 9 || (parsed.minor === 9 && parsed.patch >= 12))) ||
    (parsed.major === 5 && (parsed.minor > 0 || (parsed.minor === 0 && parsed.patch >= 2))) ||
    parsed.major > 5;
  const supportsCatalogZones = gte(parsed, { major: 4, minor: 7, patch: 0 });
  const supportsViews = gte(parsed, { major: 5, minor: 0, patch: 0 });
  const supportsTsigApi = gte(parsed, { major: 4, minor: 1, patch: 0 });

  return {
    version: rawVersion,
    serverId,
    parsed,
    capabilities: {
      supportsExtendPrune,
      supportsCatalogZones,
      supportsViews,
      supportsTsigApi,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/** True if a cached snapshot is fresher than `ttlMs`. */
export function isVersionCacheFresh(
  cache: PdnsVersionCache | null,
  ttlMs: number,
): cache is PdnsVersionCache {
  if (!cache) return false;
  const fetchedAt = Date.parse(cache.fetchedAt);
  if (Number.isNaN(fetchedAt)) return false;
  return Date.now() - fetchedAt < ttlMs;
}
