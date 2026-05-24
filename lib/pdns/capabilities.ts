/**
 * lib/pdns/capabilities.ts
 *
 * Derives a backend's OBSERVED daemon capabilities from its read-only `/config`
 * (ADR-0014). Pure — no I/O. The daemon's file-based flags are the truth about
 * what it can do, and a single daemon can be primary AND secondary at once,
 * which is why this replaces the operator-declared `role`.
 */

import type { PdnsConfigSetting, PdnsDaemonCapabilities } from "./types";

const isYes = (v: string | undefined): boolean => v?.toLowerCase() === "yes";

/** Parse `launch` (comma/space separated, entries may be `backend:instance`). */
function parseLaunch(value: string | undefined): string[] {
  if (!value) return [];
  const names = value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(":")[0] ?? s);
  return [...new Set(names)];
}

/**
 * Reduce a daemon's full `/config` to the capability flags ADR-0014 reasons
 * about. Accepts the 4.5+ names and their legacy aliases (`master`/`slave`/
 * `superslave`) interchangeably — either being `yes` counts.
 */
export function deriveCapabilities(
  config: readonly PdnsConfigSetting[],
  opts?: { autoprimaryCount?: number },
): PdnsDaemonCapabilities {
  const map = new Map<string, string>();
  for (const c of config) map.set(c.name.toLowerCase(), c.value);

  const backends = parseLaunch(map.get("launch"));
  // gsqlite3/gmysql/gpgsql gate DNSSEC behind `<backend>-dnssec=yes`; lmdb is
  // always DNSSEC-capable with no flag.
  const dnssec =
    config.some((c) => /-dnssec$/i.test(c.name) && isYes(c.value)) || backends.includes("lmdb");

  return {
    // We only ever call this on a successful /config read, so the API is on
    // even if the daemon doesn't echo the `api` flag back.
    api: map.has("api") ? isYes(map.get("api")) : true,
    primary: isYes(map.get("primary")) || isYes(map.get("master")),
    secondary: isYes(map.get("secondary")) || isYes(map.get("slave")),
    autosecondary: isYes(map.get("autosecondary")) || isYes(map.get("superslave")),
    backends,
    dnssec,
    ...(opts?.autoprimaryCount !== undefined ? { autoprimaryCount: opts.autoprimaryCount } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Whether a backend is a write target — the ADR-0014 classification that
 * replaces the old `role`. An unprobed backend (no capability snapshot yet) is
 * treated as writable so a freshly-added one is usable until its first probe;
 * once observed, the daemon's `primary` flag is the truth. A daemon that is
 * both primary AND secondary counts as a write target (its mirror zones stay
 * read-only per zone kind).
 */
export function isWriteCapable(caps: PdnsDaemonCapabilities | null | undefined): boolean {
  return caps ? caps.primary : true;
}

/**
 * Whether a backend is purely a read-only mirror — observed secondary, not
 * primary. Unprobed backends are NOT mirrors (they default to writable).
 */
export function isReadOnlyMirror(caps: PdnsDaemonCapabilities | null | undefined): boolean {
  return !!caps && caps.secondary && !caps.primary;
}

/** Derived composition of a backend group (ADR-0014), from its members. */
export interface GroupComposition {
  /** Write-capable members (primaries / unprobed). */
  writable: number;
  /** Read-only mirror members. */
  mirrors: number;
  /**
   * A true multi-primary cluster — ≥2 writable peers sharing storage. Only
   * these have a meaningful peer-selection strategy; a primary+secondaries
   * group has a single write target, so the strategy is irrelevant there.
   */
  isMultiPrimary: boolean;
  /** Human label: "Multi-primary cluster", "Primary + secondaries", … */
  typeLabel: string;
}

/** Classify a group from its members' observed capabilities. */
export function classifyGroup(
  members: ReadonlyArray<{ capabilities: PdnsDaemonCapabilities | null }>,
): GroupComposition {
  const writable = members.filter((m) => isWriteCapable(m.capabilities)).length;
  const mirrors = members.filter((m) => isReadOnlyMirror(m.capabilities)).length;
  const isMultiPrimary = writable >= 2;
  const typeLabel = isMultiPrimary
    ? "Multi-primary cluster"
    : writable >= 1 && mirrors >= 1
      ? "Primary + secondaries"
      : writable >= 1
        ? "Single primary"
        : mirrors >= 1
          ? "Secondaries only"
          : "Empty group";
  return { writable, mirrors, isMultiPrimary, typeLabel };
}

/**
 * Capability summary for the servers UI — the literal daemon `/config` flags that
 * are `yes`, verbatim ("primary", "secondary", "autosecondary"), joined with
 * " + ". NOT paraphrased: the badge shows exactly the capability the API reports,
 * so it never invents a label like "Secondary (auto)". With no replication flag
 * set it falls back to the only flag that's on (`api`); "unknown" when the daemon
 * has never been observed.
 */
export function summarizeCapabilities(caps: PdnsDaemonCapabilities | null): string {
  if (!caps) return "unknown";
  const flags: string[] = [];
  if (caps.primary) flags.push("primary");
  if (caps.secondary) flags.push("secondary");
  if (caps.autosecondary) flags.push("autosecondary");
  if (flags.length === 0) flags.push(caps.api ? "api" : "unknown");
  return flags.join(" + ");
}
