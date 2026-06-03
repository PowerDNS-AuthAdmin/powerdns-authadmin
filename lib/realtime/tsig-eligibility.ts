/**
 * lib/realtime/tsig-eligibility.ts
 *
 * Shared TSIG key eligibility logic for workflows that need to preselect or
 * validate a key before applying it to zone transfers. A key is eligible only
 * when the same key name exists on every backend that must participate.
 */

import "server-only";
import type { PdnsServer } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import { stripTrailingDot } from "@/lib/pdns/tsig";
import type { PdnsZoneSummary } from "@/lib/pdns/types";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { getBackendGateway } from "./backend-gateway";
import { listPrimarySecondaries } from "./tsig-replication";

const AUTHORITATIVE_KINDS = new Set(["master", "primary"]);

export interface EligibleTsigKey {
  name: string;
  zoneCount: number;
  zones: string[];
}

interface TsigEligibilityOptions {
  /** Every backend in this set must already hold the key. */
  keyHosts: readonly PdnsServer[];
  /** Authoritative backends whose zones contribute usage counts. */
  zoneHosts: readonly PdnsServer[];
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

function uniqueServers(servers: readonly PdnsServer[]): PdnsServer[] {
  return [...new Map(servers.map((s) => [s.id, s])).values()];
}

async function listKeyNames(server: PdnsServer): Promise<Set<string>> {
  const keys = await getBackendGateway(server).listTsigKeys();
  return new Set(keys.map((k) => stripTrailingDot(k.name)));
}

function intersectKeySets(sets: ReadonlyArray<Set<string>>): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first!].filter((name) => rest.every((set) => set.has(name))));
}

async function authoritativeZones(server: PdnsServer): Promise<PdnsZoneSummary[]> {
  const zones = await getBackendGateway(server)
    .listZones()
    .catch((err: unknown) => {
      logger.warn(
        {
          server: server.slug,
          err: err instanceof Error ? redact(err.message) : "unknown",
        },
        "tsig.eligibility.zone-list.failed",
      );
      return [];
    });

  return zones.filter((z) => AUTHORITATIVE_KINDS.has(z.kind.toLowerCase()));
}

async function countZonesByKey(
  zoneHosts: readonly PdnsServer[],
  candidateNames: ReadonlySet<string>,
): Promise<Map<string, Set<string>>> {
  const zonesByKey = new Map<string, Set<string>>();

  for (const host of uniqueServers(zoneHosts)) {
    const client = getBackendGateway(host);
    const zoneNames = (await authoritativeZones(host)).map((z) => z.name).sort();
    const details = await mapLimit(zoneNames, 8, async (zoneName) => {
      try {
        return await client.getZone(zoneName, { rrsets: false });
      } catch (err) {
        logger.warn(
          {
            server: host.slug,
            zone: zoneName,
            err: err instanceof Error ? redact(err.message) : "unknown",
          },
          "tsig.eligibility.zone-detail.failed",
        );
        return null;
      }
    });

    for (const zone of details) {
      if (!zone) continue;
      for (const raw of zone.master_tsig_key_ids ?? []) {
        const keyName = stripTrailingDot(raw);
        if (!candidateNames.has(keyName)) continue;
        const set = zonesByKey.get(keyName) ?? new Set<string>();
        set.add(zone.name);
        zonesByKey.set(keyName, set);
      }
    }
  }

  return zonesByKey;
}

export async function listEligibleTsigKeys({
  keyHosts,
  zoneHosts,
}: TsigEligibilityOptions): Promise<EligibleTsigKey[]> {
  const hosts = uniqueServers(keyHosts);
  if (hosts.length === 0) return [];

  let keySets: Array<Set<string>>;
  try {
    keySets = await Promise.all(hosts.map((host) => listKeyNames(host)));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? redact(err.message) : "unknown" },
      "tsig.eligibility.key-list.failed",
    );
    return [];
  }

  const commonNames = intersectKeySets(keySets);
  if (commonNames.size === 0) return [];

  const counts = await countZonesByKey(zoneHosts.length > 0 ? zoneHosts : hosts, commonNames);
  return [...commonNames]
    .map((name) => {
      const zones = [...(counts.get(name) ?? new Set<string>())].sort();
      return { name, zoneCount: zones.length, zones };
    })
    .sort((a, b) => b.zoneCount - a.zoneCount || a.name.localeCompare(b.name));
}

export async function assertTsigKeyPresentOnAll(
  hosts: readonly PdnsServer[],
  keyName: string,
): Promise<void> {
  const normalized = stripTrailingDot(keyName);
  const missing: Array<{ slug: string; name: string }> = [];

  for (const host of uniqueServers(hosts)) {
    try {
      const keys = await listKeyNames(host);
      if (!keys.has(normalized)) missing.push({ slug: host.slug, name: host.name });
    } catch {
      missing.push({ slug: host.slug, name: host.name });
    }
  }

  if (missing.length > 0) {
    throw new ValidationError(
      "TSIG key must exist on the primary and every secondary before it can be applied to a new Primary zone.",
      { missingBackends: missing },
    );
  }
}

export async function assertTsigKeyPresentOnPrimaryAndSecondaries(
  primary: PdnsServer,
  keyName: string,
): Promise<void> {
  const secondaries = await listPrimarySecondaries(primary);
  await assertTsigKeyPresentOnAll([primary, ...secondaries], keyName);
}
