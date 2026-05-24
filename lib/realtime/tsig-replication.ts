/**
 * lib/realtime/tsig-replication.ts
 *
 * Orchestration for replicating a TSIG key + its per-zone AXFR activation from a
 * primary onto its secondaries. The pure install logic lives in
 * `lib/pdns/tsig-install`; this layer wires it to real backends through the
 * gateway (so reachability is tracked) and to the topology (group + derived
 * secondaries).
 *
 *   • replicateKeyToSecondaries — push the primary's exact secret to each
 *     secondary's TSIG API. Per-backend version-gated on `supportsTsigApi`;
 *     older daemons report `unsupported` (the UI falls back to manual pdnsutil).
 *   • setZoneTransferKey — activate (or clear) a key for ONE zone's transfer:
 *     TSIG-ALLOW-AXFR on the primary, AXFR-MASTER-TSIG on each secondary that
 *     actually hosts the zone.
 *   • listPrimarySecondaries — the primary's secondaries: explicit group members
 *     ∪ masters[]-derived mirrors.
 */

import "server-only";
import type { PdnsServer } from "@/lib/db/schema";
import { findPdnsServerById, listSecondariesForPrimary } from "@/lib/db/repositories/pdns-servers";
import { derivedMirrorsForPrimary } from "@/lib/pdns/topology-cache";
import { installKeyOnBackend, type TsigInstallOutcome } from "@/lib/pdns/tsig-install";
import { PdnsNotFoundError, PdnsUpstreamError } from "@/lib/pdns/errors";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { stripTrailingDot } from "@/lib/pdns/tsig";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { getBackendGateway } from "./backend-gateway";

const AUTHORITATIVE_KINDS = new Set(["master", "primary"]);

/** A primary's secondaries: explicit group members ∪ masters[]-derived mirrors. */
export async function listPrimarySecondaries(primary: PdnsServer): Promise<PdnsServer[]> {
  const group = await listSecondariesForPrimary(primary);
  const byId = new Map(group.map((s) => [s.id, s]));
  for (const secId of derivedMirrorsForPrimary(primary.id).keys()) {
    if (secId === primary.id || byId.has(secId)) continue;
    const row = await findPdnsServerById(secId);
    if (row?.disabledAt === null) byId.set(secId, row);
  }
  return [...byId.values()];
}

export interface SecondaryInstallResult {
  serverId: string;
  serverSlug: string;
  serverName: string;
  /** install outcome, or why we couldn't: version too old / unreachable / error. */
  outcome: TsigInstallOutcome | "unsupported" | "unreachable" | "error";
}

export interface ReplicateResult {
  keyName: string;
  algorithm: string;
  results: SecondaryInstallResult[];
}

/**
 * Fetch the primary's key secret and install it on every secondary that supports
 * the TSIG API. Never sends the secret to the client. Idempotent; conflicts
 * (same name, different secret) are reported, not overwritten.
 */
export async function replicateKeyToSecondaries(
  primary: PdnsServer,
  keyId: string,
): Promise<ReplicateResult> {
  const detail = await getBackendGateway(primary).getTsigKey(keyId);
  const material = { name: detail.name, algorithm: detail.algorithm, secret: detail.key };
  const secondaries = await listPrimarySecondaries(primary);

  const results = await Promise.all(
    secondaries.map(async (s): Promise<SecondaryInstallResult> => {
      const base = { serverId: s.id, serverSlug: s.slug, serverName: s.name };
      if (!s.versionCache?.capabilities.supportsTsigApi) {
        return { ...base, outcome: "unsupported" };
      }
      try {
        return { ...base, outcome: await installKeyOnBackend(getBackendGateway(s), material) };
      } catch (err) {
        logger.warn(
          { server: s.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
          "tsig.replicate.install.failed",
        );
        return { ...base, outcome: err instanceof PdnsUpstreamError ? "unreachable" : "error" };
      }
    }),
  );

  return { keyName: detail.name, algorithm: detail.algorithm, results };
}

export type TransferKeyMode = "add" | "remove";

export interface ZoneTransferKeyResult {
  /** master_tsig_key_ids updated on the primary. */
  primaryOk: boolean;
  secondaries: Array<{
    serverSlug: string;
    serverName: string;
    /** Whether the secondary actually hosts the zone (else there's nothing to set). */
    hosted: boolean;
    ok: boolean;
  }>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Add/remove `keyName` to/from a key-id list without dropping the others, with
 * trailing-dot normalization: existing entries are de-duped to their dot-less
 * form (so a re-PUT collapses any "test" + "test." duplicate), and a remove
 * drops every form of the key.
 */
function applyMode(current: readonly string[], keyName: string, mode: TransferKeyMode): string[] {
  const target = stripTrailingDot(keyName);
  const kept = [...new Set(current.map(stripTrailingDot))].filter((k) => k !== target);
  return mode === "add" ? [...kept, target] : kept;
}

/**
 * Add or remove a TSIG key on ONE zone's AXFR — the WRITABLE zone-object fields
 * (`master_tsig_key_ids` on the primary, `slave_tsig_key_ids` on each secondary
 * that hosts the zone), which PDNS surfaces read-only as TSIG-ALLOW-AXFR /
 * AXFR-MASTER-TSIG. (The per-kind metadata API rejects those as read-only.)
 *
 * NON-CLOBBERING: each backend is read-modify-written, so we only add/remove the
 * one key and never disturb other keys already configured on the zone. A no-op
 * (already present / already absent) skips the PUT. A secondary without the zone
 * (404) is reported `hosted: false`, not an error.
 */
export async function setZoneTransferKey(
  primary: PdnsServer,
  zoneName: string,
  keyName: string,
  mode: TransferKeyMode,
): Promise<ZoneTransferKeyResult> {
  let primaryOk = true;
  try {
    const c = getBackendGateway(primary);
    const current = (await c.getZone(zoneName)).master_tsig_key_ids ?? [];
    const next = applyMode(current, keyName, mode);
    if (!sameSet(next, current))
      await c.updateZoneSettings(zoneName, { master_tsig_key_ids: next });
  } catch (err) {
    primaryOk = false;
    logger.warn(
      {
        server: primary.slug,
        zone: zoneName,
        err: err instanceof Error ? redact(err.message) : "unknown",
      },
      "tsig.zone-transfer.primary.failed",
    );
  }

  const secondaries = await listPrimarySecondaries(primary);
  const secResults = await Promise.all(
    secondaries.map(async (s) => {
      const base = { serverSlug: s.slug, serverName: s.name };
      try {
        const c = getBackendGateway(s);
        const current = (await c.getZone(zoneName)).slave_tsig_key_ids ?? [];
        const next = applyMode(current, keyName, mode);
        if (!sameSet(next, current)) {
          await c.updateZoneSettings(zoneName, { slave_tsig_key_ids: next });
        }
        return { ...base, hosted: true, ok: true };
      } catch (err) {
        if (err instanceof PdnsNotFoundError) return { ...base, hosted: false, ok: true };
        logger.warn(
          {
            server: s.slug,
            zone: zoneName,
            err: err instanceof Error ? redact(err.message) : "unknown",
          },
          "tsig.zone-transfer.secondary.failed",
        );
        return { ...base, hosted: true, ok: false };
      }
    }),
  );

  return { primaryOk, secondaries: secResults };
}

export interface CascadeDeleteResult {
  keyName: string;
  /** Zones we removed the key from (primary side; secondaries cleaned with each). */
  zonesUpdated: number;
  /** Secondaries the key copy was deleted from. */
  secondariesCleaned: number;
}

/** Run an async mapper over `items` at most `limit` at a time. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/**
 * Delete a TSIG key AND clean up after it (the default, opt-out, delete path):
 *   1. Remove it from every authoritative zone that references it — on the
 *      primary (master_tsig_key_ids) and, via `setZoneTransferKey`, on the
 *      hosting secondaries (slave_tsig_key_ids) — so no zone is left pointing at
 *      a key that's about to vanish.
 *   2. Delete the replicated key copy from each secondary.
 *   3. Delete the key from the primary.
 *
 * Zone discovery is a bounded-concurrency scan of the primary's authoritative
 * zones (PDNS has no reverse "which zones use this key" index). Best-effort: a
 * per-zone / per-secondary failure is logged, not fatal, so the primary delete
 * still proceeds. The caller has the broker store warm so the zone NAMES come
 * from cache (only the master_tsig_key_ids check needs a getZone).
 */
export async function cascadeDeleteTsigKey(
  primary: PdnsServer,
  keyId: string,
): Promise<CascadeDeleteResult> {
  const primaryClient = getBackendGateway(primary);
  const keyName = stripTrailingDot((await primaryClient.getTsigKey(keyId)).name);

  // 1. Strip the key from authoritative zones that reference it.
  const zoneNames = [...(readCachedZones(primary.id)?.zones.values() ?? [])]
    .filter((z) => AUTHORITATIVE_KINDS.has(z.kind.toLowerCase()))
    .map((z) => z.name);
  const updated = await mapLimit(zoneNames, 8, async (zone) => {
    try {
      const z = await primaryClient.getZone(zone);
      // PDNS returns master_tsig_key_ids as DNS names ("k."); compare dot-less.
      if (!(z.master_tsig_key_ids ?? []).some((k) => stripTrailingDot(k) === keyName)) return false;
      await setZoneTransferKey(primary, zone, keyName, "remove");
      return true;
    } catch (err) {
      logger.warn(
        { server: primary.slug, zone, err: err instanceof Error ? redact(err.message) : "unknown" },
        "tsig.cascade.zone.failed",
      );
      return false;
    }
  });
  const zonesUpdated = updated.filter(Boolean).length;

  // 2. Delete the key copy from each secondary.
  const secondaries = await listPrimarySecondaries(primary);
  const cleaned = await Promise.all(
    secondaries.map(async (s) => {
      try {
        const sc = getBackendGateway(s);
        const sk = (await sc.listTsigKeys()).find((k) => k.name === keyName);
        if (!sk) return false;
        await sc.deleteTsigKey(sk.id);
        return true;
      } catch (err) {
        logger.warn(
          { server: s.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
          "tsig.cascade.secondary.failed",
        );
        return false;
      }
    }),
  );

  // 3. Delete from the primary (the authoritative removal).
  await primaryClient.deleteTsigKey(keyId);

  return { keyName, zonesUpdated, secondariesCleaned: cleaned.filter(Boolean).length };
}
