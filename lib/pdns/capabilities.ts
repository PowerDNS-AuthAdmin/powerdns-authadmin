/**
 * lib/pdns/capabilities.ts
 *
 * Derives a backend's OBSERVED daemon capabilities from its read-only `/config`
 * (ADR-0014). Pure - no I/O. The daemon's file-based flags are the truth about
 * what it can do, and a single daemon can be primary AND secondary at once,
 * which is why this replaces the operator-declared `role`.
 */

import type { PdnsConfigSetting, PdnsDaemonCapabilities, PdnsWriteMode } from "./types";

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
 * `superslave`) interchangeably - either being `yes` counts.
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
 * Whether a backend is a write target - the ADR-0014 classification that
 * replaces the old `role`. An unprobed backend (no capability snapshot yet) is
 * treated as writable so a freshly-added one is usable until its first probe;
 * once observed, anything that isn't a pure read-only AXFR mirror is a write
 * target. That covers the three usable shapes a PDNS Auth daemon can take:
 *
 *   - **standalone** (`primary=no, secondary=no`) - the *default* PDNS Auth
 *     config; no DNS-protocol replication, but the API still accepts zone
 *     creates. This is the case the previous `caps.primary` check incorrectly
 *     excluded (#57).
 *   - **primary** (`primary=yes`) - write target plus AXFR primary.
 *   - **dual-role** (`primary=yes, secondary=yes`) - primary for some zones,
 *     secondary for others; the per-zone `kind` decides which.
 *
 * Only a pure mirror (`secondary=yes && !primary`) returns false here.
 */
export function isWriteCapable(caps: PdnsDaemonCapabilities | null | undefined): boolean {
  return caps ? !isReadOnlyMirror(caps) : true;
}

/**
 * Whether a backend is purely a read-only mirror - observed secondary, not
 * primary. Unprobed backends are NOT mirrors (they default to writable).
 */
export function isReadOnlyMirror(caps: PdnsDaemonCapabilities | null | undefined): boolean {
  return !!caps && caps.secondary && !caps.primary;
}

/** The subset of a backend row this module reasons about. */
export interface WriteRoutable {
  capabilities: PdnsDaemonCapabilities | null;
  writeMode: PdnsWriteMode;
}

/**
 * Whether a backend may actually be written to - the predicate every write-
 * routing decision must use, rather than {@link isWriteCapable} alone.
 *
 * `/config` cannot express "this daemon's database user is read-only" (#111).
 * A public nameserver serving native zones fed by database replication reports
 * `primary=no, secondary=no`, which is byte-identical to a standalone primary,
 * so {@link deriveCapabilities} necessarily calls it writable and the cluster
 * picker happily rotates writes onto it. The operator's `write_mode` override
 * is the only signal that can correct that, so it wins here.
 *
 * The override can only ever *subtract*: `read_only` vetoes a daemon the
 * capabilities said was writable, but `auto` never promotes a read-only mirror
 * into a write target.
 *
 * SCOPE: this governs write ROUTING and the operator-facing backend pickers,
 * not AXFR topology derivation. `lib/realtime/zone-poller.ts` and
 * `lib/pdns/sync.ts` keep using {@link isWriteCapable} on the raw capabilities
 * deliberately - they resolve mirror zones' `masters[]` back to the daemon
 * that actually serves the AXFR, which is a fact about the DNS protocol that
 * an operator's write-routing preference must not rewrite. Marking a genuine
 * AXFR primary `read_only` should stop writes going to it, not make the
 * secondaries that pull from it un-resolvable.
 */
export function isServerWriteTarget(server: WriteRoutable): boolean {
  return server.writeMode !== "read_only" && isWriteCapable(server.capabilities);
}

/**
 * Whether a backend is excluded from writes for any reason - an observed
 * read-only mirror, or an operator-declared `read_only` override. The
 * complement of {@link isServerWriteTarget}, named for UI that groups
 * "everything we only read from" together.
 */
export function isReadOnlyBackend(server: WriteRoutable): boolean {
  return !isServerWriteTarget(server);
}

/** Derived composition of a backend group (ADR-0014), from its members. */
export interface GroupComposition {
  /** Members that may be written to (primaries / unprobed, minus overrides). */
  writable: number;
  /** Members we only ever read from - observed mirrors plus `read_only` overrides. */
  mirrors: number;
  /**
   * A true multi-primary cluster - ≥2 writable peers sharing storage. Only
   * these have a meaningful peer-selection strategy; a primary+secondaries
   * group has a single write target, so the strategy is irrelevant there.
   */
  isMultiPrimary: boolean;
  /** Human label: "Multi-primary cluster", "Primary + secondaries", … */
  typeLabel: string;
}

/** Classify a group from its members' observed capabilities. */
export function classifyGroup(members: readonly WriteRoutable[]): GroupComposition {
  // Counted off the routing predicate, not the raw capabilities: a group of
  // one hidden primary plus three `read_only` public nameservers has exactly
  // one write target, so it must not present itself as multi-primary and
  // offer a peer-selection strategy that would do nothing (#111).
  const writable = members.filter(isServerWriteTarget).length;
  const mirrors = members.length - writable;
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
 * Capability summary for the servers UI - the literal daemon `/config` flags that
 * are `yes`, verbatim ("primary", "secondary", "autosecondary"), joined with
 * " + ". NOT paraphrased: the badge shows exactly the capability the API reports,
 * so it never invents a label like "Secondary (auto)". With no replication flag
 * set it falls back to "standalone" (the daemon hosts zones over the API but does
 * no DNS-protocol replication - the default PDNS Auth shape); "unknown" when the
 * daemon has never been observed, "unreachable" when the API itself is down.
 */
export function summarizeCapabilities(caps: PdnsDaemonCapabilities | null): string {
  if (!caps) return "unknown";
  const flags: string[] = [];
  if (caps.primary) flags.push("primary");
  if (caps.secondary) flags.push("secondary");
  if (caps.autosecondary) flags.push("autosecondary");
  if (flags.length === 0) flags.push(caps.api ? "standalone" : "unreachable");
  return flags.join(" + ");
}
