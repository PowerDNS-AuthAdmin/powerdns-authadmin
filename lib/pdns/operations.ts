/**
 * lib/pdns/operations.ts
 *
 * Higher-level PDNS operations that compose the protocol-level
 * methods on `PdnsClient` with the policies we want every caller to
 * follow. Today this is purely about NOTIFY: every code path that
 * creates or rewrites a zone on a Master/Primary should trigger a
 * NOTIFY so secondaries pick the change up immediately instead of
 * waiting for their next refresh (typically tens of minutes to an
 * hour, governed by the zone's SOA-refresh).
 *
 * Pre-this-module we had three create-zone callsites (admin POST,
 * provisioning's demo-zone generator, the clone route) and only the
 * admin POST remembered to fire NOTIFY afterwards. On a fresh
 * `docker compose up` the provisioning path raced the secondaries'
 * supermaster registration — zones got created on the primary BEFORE
 * the secondaries were ready to receive NOTIFY, so the freshly-
 * provisioned demo stacks looked desynced for ~60s until the
 * secondaries' periodic refresh kicked in.
 *
 * `createZoneAndNotify` makes the create-then-notify pattern the
 * default at every create-zone callsite, and
 * `notifyEveryZoneBestEffort` provides the post-provisioning sweep
 * that catches zones whose initial NOTIFY hit a not-yet-ready
 * secondary.
 */

import "server-only";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import type { PdnsClient } from "./client";
import type { PdnsZoneDetail, PdnsZoneSummary } from "./types";

/** Mirror of `PdnsClient.createZone`'s parameter shape. Kept local so
 *  callers don't have to reach into the protocol module. */
type CreateZoneParams = Parameters<PdnsClient["createZone"]>[0];

/**
 * Kinds that benefit from an outbound NOTIFY. Native zones aren't
 * replicated, so PDNS rejects NOTIFY on them; sending one would just
 * generate a misleading log line.
 */
function isPrimaryKind(kind: string): boolean {
  return kind === "Master" || kind === "Primary";
}

/**
 * Create a zone, then best-effort NOTIFY when the kind warrants it.
 * NOTIFY failures are logged but never bubble — the zone is created
 * regardless; the secondaries will catch up on their next refresh
 * even if NOTIFY couldn't be delivered.
 */
export async function createZoneAndNotify(
  client: PdnsClient,
  input: CreateZoneParams,
): Promise<PdnsZoneDetail> {
  const created = await client.createZone(input);
  if (isPrimaryKind(input.kind)) {
    await notifyZoneBestEffort(client, input.name);
  }
  return created;
}

/**
 * Fire-and-forget NOTIFY wrapper used by every callsite that wants
 * "tell the secondaries something changed, but don't make me handle
 * the failure." Returns the success bool for callers that audit.
 */
export async function notifyZoneBestEffort(
  client: PdnsClient,
  zoneName: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    await client.notifyZone(zoneName);
    return { ok: true, error: null };
  } catch (err) {
    const error = err instanceof Error ? redact(err.message) : "unknown";
    logger.warn({ zone: zoneName, error }, "pdns.notify.best-effort.failed");
    return { ok: false, error };
  }
}

/**
 * Iterate every zone on a backend and NOTIFY each Master/Primary
 * one. Used by the provisioning sweep + post-restart convergence
 * paths to recover from a window where the primary held zones
 * that the secondaries hadn't seen — i.e. exactly the
 * `docker compose up` race the demo stacks were exhibiting.
 *
 * Returns per-zone status so callers can audit how many notifies
 * fired vs how many were no-ops vs how many failed.
 */
export async function notifyEveryZoneBestEffort(
  client: PdnsClient,
): Promise<{ notified: number; skipped: number; failed: number }> {
  let zones: PdnsZoneSummary[];
  try {
    zones = await client.listZones();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? redact(err.message) : "unknown" },
      "pdns.notify-sweep.list-failed",
    );
    return { notified: 0, skipped: 0, failed: 0 };
  }

  const primaries = zones.filter((z) => isPrimaryKind(z.kind));
  const skipped = zones.length - primaries.length;

  // Notify in bounded-concurrency batches: a backend with thousands of
  // primary zones shouldn't take thousands of serial round-trips, but we
  // also don't want to open a socket per zone all at once.
  const CONCURRENCY = 8;
  let notified = 0;
  let failed = 0;
  for (let i = 0; i < primaries.length; i += CONCURRENCY) {
    const batch = primaries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((z) => notifyZoneBestEffort(client, z.name)));
    for (const r of results) {
      if (r.ok) notified += 1;
      else failed += 1;
    }
  }
  return { notified, skipped, failed };
}
