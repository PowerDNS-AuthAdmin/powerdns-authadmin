/**
 * lib/pdns/tsig-install.ts
 *
 * Replicating a TSIG key from a primary onto its secondaries so AXFR
 * authenticates - both ends must hold the IDENTICAL secret (name + algorithm +
 * key). Two delivery paths, both surfaced in the UI:
 *
 *   • API-driven (`installKeyOnBackend`): the app POSTs the imported secret to
 *     the secondary's TSIG API. Requires the daemon's TSIG API (≥ 4.1); the
 *     caller gates on `version_cache.capabilities.supportsTsigApi`.
 *   • Manual (`tsigManualCommands`): version-agnostic `pdnsutil` commands the
 *     operator runs on the box - for older daemons or air-gapped setups.
 *
 * Conflict policy (decided): if a secondary already holds a key of the same
 * name with a DIFFERENT secret, we DON'T overwrite (it may be in use by other
 * zones) - we report `conflict` and let the operator resolve it.
 *
 * Pure + dependency-light: the API path is parameterized on a minimal client
 * interface so it's unit-testable with a fake; no I/O of its own.
 */

/** What `installKeyOnBackend` did (or couldn't do) on one secondary. */
export type TsigInstallOutcome = "created" | "unchanged" | "conflict";

/** The slice of `PdnsClient` the installer needs (so tests can fake it). */
export interface TsigInstallClient {
  listTsigKeys(): Promise<ReadonlyArray<{ id: string; name: string; algorithm: string }>>;
  getTsigKey(id: string): Promise<{ id: string; name: string; algorithm: string; key: string }>;
  createTsigKey(input: { name: string; algorithm: string; key: string }): Promise<unknown>;
}

export interface TsigKeyMaterial {
  name: string;
  algorithm: string;
  /** Base64 HMAC secret. */
  secret: string;
}

const sameAlgo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Idempotently install `key` on one backend. Looks the key up by NAME (PDNS's
 * tsigkey id isn't guaranteed equal to the name), then:
 *   - absent          → create with the imported secret  → "created"
 *   - present, matches → no-op                            → "unchanged"
 *   - present, differs → leave it, report                 → "conflict"
 * Throws only on unexpected I/O - the caller maps that to an error result.
 */
export async function installKeyOnBackend(
  client: TsigInstallClient,
  key: TsigKeyMaterial,
): Promise<TsigInstallOutcome> {
  const existing = (await client.listTsigKeys()).find((k) => k.name === key.name);
  if (existing) {
    const detail = await client.getTsigKey(existing.id);
    return detail.key === key.secret && sameAlgo(detail.algorithm, key.algorithm)
      ? "unchanged"
      : "conflict";
  }
  await client.createTsigKey({ name: key.name, algorithm: key.algorithm, key: key.secret });
  return "created";
}

export interface TsigManualCommands {
  /** Run on each secondary to import the shared secret. */
  importOnSecondary: string;
  /** Per zone, run on each secondary so it signs AXFR with this key. */
  secondaryPerZone: string[];
  /** Per zone, run on the primary so this key is allowed to AXFR it. */
  primaryPerZone: string[];
}

/**
 * `pdnsutil` commands to import + activate a TSIG key. Uses the dedicated
 * `activate-tsig-key` (it sets the TSIG-ALLOW-AXFR / AXFR-MASTER-TSIG metadata
 * correctly), with the `primary`/`secondary` direction (PDNS ≥ 4.5; our floor is
 * 4.6). The command STRUCTURE changed in 5.0 (`pdnsutil <verb>-tsig-key` →
 * `pdnsutil tsigkey <verb>`), so `modernCli` selects the right form per the
 * target's major version. `zones` are FQDNs with the trailing dot as PDNS reports.
 */
export function tsigManualCommands(
  key: TsigKeyMaterial,
  zones: readonly string[] = [],
  opts: { modernCli?: boolean } = {},
): TsigManualCommands {
  const modern = opts.modernCli ?? false;
  const importCmd = modern
    ? `pdnsutil tsigkey import ${key.name} ${key.algorithm} ${key.secret}`
    : `pdnsutil import-tsig-key ${key.name} ${key.algorithm} ${key.secret}`;
  const activate = (zone: string, dir: "primary" | "secondary"): string =>
    modern
      ? `pdnsutil tsigkey activate ${zone} ${key.name} ${dir}`
      : `pdnsutil activate-tsig-key ${zone} ${key.name} ${dir}`;
  return {
    importOnSecondary: importCmd,
    secondaryPerZone: zones.map((z) => activate(z, "secondary")),
    primaryPerZone: zones.map((z) => activate(z, "primary")),
  };
}
