/**
 * lib/health/evaluator.ts
 *
 * Pure backend-health evaluator (ADR-0015). Computes the advisory set for ONE
 * backend from its observed state - reachability, daemon capabilities, the zone
 * inventory by kind, and a pre-computed replication-drift duration. No I/O. The
 * poller runs this each cycle and upserts/prunes the `backend_advisories` table,
 * so advisories self-heal.
 *
 * SIGNAL OVER NOISE: the rule set is deliberately small and actionable -
 * reachability + capability-vs-inventory contradictions a human should fix. No
 * style opinions ("you should sign this zone"). Two levers keep drift from
 * crying wolf: the cross-backend duration is measured in the poller and only
 * counts here past `DRIFT_THRESHOLD_MS` (so a transient AXFR never trips it),
 * and the repo's debounce + acknowledge live outside this module. This file just
 * states what's true right now.
 */

import type { PdnsDaemonCapabilities } from "@/lib/pdns/types";

export type AdvisorySeverity = "error" | "warn" | "info";

export interface EvaluatedAdvisory {
  /** Stable rule id - one row per (backend, code). */
  code: string;
  severity: AdvisorySeverity;
  title: string;
  detail: string;
}

export interface BackendHealthInput {
  /** Reached the backend's API recently (last_seen_at within threshold). */
  reachable: boolean;
  /**
   * Network reached but the API rejected us (401/403). Distinct from
   * unreachable: the daemon is up, the key/ACL is wrong. Only meaningful when
   * `reachable` is false.
   */
  authError?: boolean;
  /** Observed daemon capabilities, or null if never probed. */
  capabilities: PdnsDaemonCapabilities | null;
  /** Zone counts keyed by lowercased PowerDNS kind (master/native/slave/…). */
  zoneKinds: Readonly<Record<string, number>>;
  /** Mirror-kind zones (slave/secondary/consumer) carrying an empty `masters[]`. */
  mirrorZonesWithoutMasters?: number;
  /**
   * How long this backend has continuously lagged its primary's serial, in ms -
   * computed cross-backend by the poller. `null`/omitted = in sync, no managed
   * primary, or not comparable. Compared against `DRIFT_THRESHOLD_MS` here.
   */
  replicationDriftMs?: number | null;
  /**
   * How many TSIG keys this secondary is MISSING that its primary replicated to
   * the rest of the group - computed cross-backend by the poller (it needs every
   * backend's `GET /tsigkeys` at once). 0/omitted = none missing or not a
   * managed secondary.
   */
  missingTransferKeys?: number;
}

/**
 * A serial mismatch must persist this long before it's reported as drift.
 * Comfortably longer than a normal AXFR catch-up (seconds), which the poller's
 * 2.5 s in-flight follow-up resolves - so only genuinely stuck replication rings
 * the bell.
 */
export const DRIFT_THRESHOLD_MS = 15 * 60_000;

const count = (kinds: Readonly<Record<string, number>>, ...keys: string[]): number =>
  keys.reduce((sum, k) => sum + (kinds[k] ?? 0), 0);

export function evaluateBackendHealth(input: BackendHealthInput): EvaluatedAdvisory[] {
  const out: EvaluatedAdvisory[] = [];

  if (!input.reachable) {
    // Capability-based rules would be stale against an unreachable daemon, so
    // exactly one reachability advisory is asserted - the specific auth variant
    // when the API answered with 401/403, else generic unreachable.
    return input.authError
      ? [
          {
            code: "backend.api-auth",
            severity: "error",
            title: "API rejected the key",
            detail:
              "The backend answered but rejected our API key (401/403). Check the X-API-Key is correct and the webserver allow-from / api ACL admits this app.",
          },
        ]
      : [
          {
            code: "backend.unreachable",
            severity: "error",
            title: "Backend unreachable",
            detail:
              "The app hasn't reached this backend's API recently. Check the daemon is running, the API key is correct, and the network path is open.",
          },
        ];
  }

  const caps = input.capabilities;
  if (!caps) return out; // not yet probed → nothing to assert

  const secondaryZones = count(input.zoneKinds, "slave", "secondary", "consumer");
  if (secondaryZones > 0 && !caps.secondary) {
    out.push({
      code: "secondary.cant-axfr",
      severity: "error",
      title: "Secondary zones can't transfer",
      detail: `Holds ${secondaryZones} secondary/consumer zone(s) but reports secondary=no - they will never AXFR from their primary. Set secondary=yes in pdns.conf.`,
    });
  }

  const noMasters = input.mirrorZonesWithoutMasters ?? 0;
  if (noMasters > 0) {
    out.push({
      code: "secondary.no-masters",
      severity: "error",
      title: "Secondary zone has no primary",
      detail: `${noMasters} secondary/consumer zone(s) have an empty masters[] - there's no address to AXFR from, so they can't replicate. Set each zone's masters to its primary's DNS address.`,
    });
  }

  if (input.replicationDriftMs != null && input.replicationDriftMs >= DRIFT_THRESHOLD_MS) {
    const thresholdMin = Math.round(DRIFT_THRESHOLD_MS / 60_000);
    out.push({
      code: "replication.drift",
      severity: "error",
      // Detail is intentionally stable (no live elapsed counter) so the upsert
      // doesn't churn it every cycle - that would re-trip the ack-invalidation
      // and re-alert endlessly. Age is carried by first_seen_at/last_seen_at.
      title: "Replication is stuck",
      detail: `This mirror's serial has lagged its primary for over ${thresholdMin} min - well past a normal transfer. Check AXFR access (allow-axfr-ips on the primary, the zone's masters[], and TSIG) and the secondary's transfer logs.`,
    });
  }

  const missingKeys = input.missingTransferKeys ?? 0;
  if (missingKeys > 0) {
    out.push({
      code: "secondary.missing-tsig-key",
      severity: "error",
      // Stable detail (count, not key names) so the upsert doesn't churn the ack
      // every cycle as the set shifts - the count moves rarely and is enough.
      title: "TSIG key missing on secondary",
      detail: `${missingKeys} TSIG key(s) the primary replicated to this group are missing on this secondary - any zone transfer (AXFR) configured to use them will fail authentication. Re-install from the primary's TSIG keys page.`,
    });
  }

  const primaryZones = count(input.zoneKinds, "master", "primary", "producer");
  if (primaryZones > 0 && !caps.primary) {
    out.push({
      code: "primary.no-notify",
      severity: "warn",
      title: "Primary zones won't NOTIFY",
      detail: `Authoritative for ${primaryZones} zone(s) but reports primary=no - it won't send NOTIFYs on change. Set primary=yes if you rely on NOTIFY-driven replication.`,
    });
  }

  // autosecondary/autoprimary intent mismatch - only when we observed the
  // autoprimary count (older snapshots / failed reads omit it).
  if (caps.autoprimaryCount !== undefined) {
    if (caps.autosecondary && caps.autoprimaryCount === 0) {
      out.push({
        code: "autosecondary.no-autoprimaries",
        severity: "warn",
        title: "autosecondary on, no autoprimaries",
        detail:
          "Reports autosecondary=yes but no autoprimaries are configured - a NOTIFY from an unknown primary won't auto-create a zone. Add the trusted autoprimary(ies), or set autosecondary=no.",
      });
    } else if (!caps.autosecondary && caps.autoprimaryCount > 0) {
      out.push({
        code: "autosecondary.disabled-with-autoprimaries",
        severity: "warn",
        title: "Autoprimaries set, autosecondary off",
        detail: `${caps.autoprimaryCount} autoprimary(ies) are configured but autosecondary=no - they're inert until you set autosecondary=yes in pdns.conf.`,
      });
    }
  }

  return out;
}
