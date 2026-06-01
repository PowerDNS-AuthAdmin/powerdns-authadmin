/**
 * lib/realtime/backend-health.ts
 *
 * THE central per-backend health operation. Every explicit, user-initiated
 * refresh - the admin "Test", "Refresh all", add-server, and first-boot
 * provisioning - goes through here instead of each re-implementing its own PDNS
 * calls. One probe path means the Test button, the status badge, and the bell
 * can never disagree.
 *
 * It mirrors exactly what the background poll observes per backend, but runs
 * synchronously and authoritatively:
 *
 *   1. listZones - the reachability probe + zone inventory (the SAME signal the
 *      poll keys reachability off, so a Test and the poll never diverge).
 *   2. (reachable) force a live version re-probe + /config + /autoprimaries,
 *      persist both, write the zone-state cache, mark last-seen.
 *   3. evaluate + sync the advisory set, publishing a health nudge when the
 *      visible set moves.
 *
 * `immediate` (the default - every caller here is user-initiated) makes the
 * advisory authoritative: it bypasses the ≥2-poll debounce so the badge + bell
 * reflect the click at once. The background poll evaluates/syncs directly
 * (debounced) so a single failed poll never rings the bell.
 */

import "server-only";
import type { PdnsServer } from "@/lib/db/schema";
import {
  listAllActiveBackends,
  markPdnsServersSeen,
  setPdnsCapabilities,
  setPdnsVersionCache,
} from "@/lib/db/repositories/pdns-servers";
import { getPdnsProbeClientForRow } from "@/lib/pdns/registry";
import type { PdnsClient } from "@/lib/pdns/client";
import { deriveCapabilities } from "@/lib/pdns/capabilities";
import { safeConfigSettings } from "@/lib/pdns/config-advice";
import { writeDaemonConfig } from "@/lib/pdns/daemon-config-cache";
import { PdnsAuthError } from "@/lib/pdns/errors";
import { evaluateBackendHealth } from "@/lib/health/evaluator";
import { syncBackendAdvisories } from "@/lib/db/repositories/backend-advisories";
import { writeCachedZones, type CachedZoneSnapshot } from "@/lib/pdns/zone-state-cache";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { publishHealthEvent } from "./event-bus";
import { getReplicationDriftMs } from "./replication-drift";
import { getTsigMissingCount } from "./tsig-presence";
import { recordBackendStatus } from "./backend-status";

const MIRROR_KINDS = new Set(["slave", "secondary", "consumer"]);

/**
 * The shared daemon-meta probe: force a live version re-probe + read /config +
 * /autoprimaries, persist both, and update `backend.capabilities` in place so a
 * same-cycle advisory eval sees the fresh snapshot. The ONE place these PDNS
 * calls live - used by both the background poll's 60 s daemon refresh and the
 * explicit `refreshBackendHealth` below. Best-effort: each sub-probe is
 * independent (the caller has already proven reachability), so a failure just
 * leaves the last-known value. Returns the observed version (or last-known).
 */
export async function probeDaemonMeta(
  client: PdnsClient,
  backend: PdnsServer,
): Promise<string | null> {
  let version: string | null = backend.versionCache?.version ?? null;
  try {
    const { cache } = await client.version({ force: true });
    version = cache.version;
    // Mutate the in-memory row too (mirrors `backend.capabilities` below) so the
    // same-cycle callers reading `versionCache.capabilities` (e.g. the poll's
    // TSIG-presence gate) see THIS probe's value, not the pre-refresh one.
    backend.versionCache = cache;
    await setPdnsVersionCache(backend.id, cache);
  } catch (err) {
    logger.warn(
      { server: backend.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
      "backend-health.version.failed",
    );
  }
  try {
    const config = await client.getConfig();
    // Cache the display-safe rows for the server-detail page (brokered - that
    // page reads the store instead of fetching /config itself).
    writeDaemonConfig(backend.id, safeConfigSettings(config));
    let autoprimaryCount: number | undefined;
    try {
      autoprimaryCount = (await client.listAutoprimaries()).length;
    } catch {
      autoprimaryCount = undefined;
    }
    const caps = deriveCapabilities(config, { autoprimaryCount });
    backend.capabilities = caps;
    await setPdnsCapabilities(backend.id, caps);
  } catch (err) {
    logger.warn(
      { server: backend.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
      "backend-health.capabilities.failed",
    );
  }
  return version;
}

export interface BackendHealthOutcome {
  /** listZones succeeded - the API is reachable and usable. */
  reachable: boolean;
  /** Network reached but the API rejected the key (401/403). */
  authError: boolean;
  /** Daemon version when reachable, else the last-known (or null). */
  version: string | null;
}

/**
 * Probe one backend's health now and persist what we observed. See file header.
 * Never throws for an unreachable backend - that's a return value, not an error;
 * callers (the Test route) report it. Truly unexpected faults propagate.
 */
export async function refreshBackendHealth(
  backend: PdnsServer,
  opts: { immediate?: boolean } = {},
): Promise<BackendHealthOutcome> {
  const immediate = opts.immediate ?? true;
  // Fast-fail probe client: an unreachable backend fails in ~5s, not ~30s, so the
  // Test/Refresh toast and the new-server first-probe resolve promptly.
  const client = getPdnsProbeClientForRow(backend);

  let reachable = false;
  let authError = false;
  let snapshots: CachedZoneSnapshot[] | null = null;
  let version: string | null = backend.versionCache?.version ?? null;

  // listZones is the reachability probe - same as the poll. A 401/403 is the
  // auth variant; any other failure (down, API disabled, bad server-id,
  // network) reads as unreachable.
  try {
    const list = await client.listZones();
    reachable = true;
    snapshots = list.map((z) => ({
      id: z.id,
      name: z.name,
      serial: z.serial ?? null,
      editedSerial: z.edited_serial ?? null,
      notifiedSerial: z.notified_serial ?? null,
      kind: z.kind,
      dnssec: z.dnssec ?? false,
      masters: z.masters ?? [],
    }));
  } catch (err) {
    authError = err instanceof PdnsAuthError;
    logger.warn(
      { server: backend.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
      "backend-health.probe.failed",
    );
  }

  // The single live reachability signal - read by every status surface.
  recordBackendStatus(backend.id, reachable, authError);

  if (reachable && snapshots) {
    version = await probeDaemonMeta(client, backend);
    writeCachedZones(backend.id, snapshots);
    try {
      await markPdnsServersSeen([backend.id]);
    } catch {
      /* non-fatal: reachability is also re-derived next poll */
    }
  }

  // Evaluate + sync the advisory set authoritatively. Drift comes from the
  // poll's state so we don't spuriously prune an active drift advisory.
  const zoneKinds: Record<string, number> = {};
  let mirrorZonesWithoutMasters = 0;
  for (const s of snapshots ?? []) {
    const k = s.kind.toLowerCase();
    zoneKinds[k] = (zoneKinds[k] ?? 0) + 1;
    if (MIRROR_KINDS.has(k) && s.masters.length === 0) mirrorZonesWithoutMasters += 1;
  }
  try {
    const changed = await syncBackendAdvisories(
      backend.id,
      evaluateBackendHealth({
        reachable,
        authError,
        capabilities: backend.capabilities,
        zoneKinds,
        mirrorZonesWithoutMasters,
        replicationDriftMs: getReplicationDriftMs(backend.id),
        // Read the poll's last cross-backend computation so a single-backend
        // Test/Refresh doesn't prune a missing-key advisory it can't recompute.
        missingTransferKeys: getTsigMissingCount(backend.id),
      }),
      { immediate },
    );
    if (changed) publishHealthEvent();
  } catch (err) {
    logger.warn(
      { server: backend.slug, err: err instanceof Error ? err.message : "unknown" },
      "backend-health.advisory-sync.failed",
    );
  }

  return { reachable, authError, version };
}

/**
 * Refresh every active backend's health in parallel - the "Refresh all" action
 * and first-boot provisioning. `failed` counts backends that aren't reachable
 * (so the toast reports outages), plus any that threw unexpectedly.
 */
export async function refreshAllBackendsHealth(): Promise<{ probed: number; failed: number }> {
  const servers = await listAllActiveBackends();
  const outcomes = await Promise.all(
    servers.map((s) =>
      refreshBackendHealth(s, { immediate: true }).then(
        (o) => o.reachable,
        (err: unknown) => {
          logger.warn(
            {
              serverId: s.id,
              serverSlug: s.slug,
              err: err instanceof Error ? err.message : "unknown",
            },
            "backend-health.refresh-all.server-failed",
          );
          return false;
        },
      ),
    ),
  );
  return { probed: servers.length, failed: outcomes.filter((ok) => !ok).length };
}
