/**
 * lib/pdns/types.ts
 *
 * Zod-validated shapes of the PowerDNS Authoritative HTTP API responses we
 * touch. Source: https://doc.powerdns.com/authoritative/http-api/
 *
 * Convention: schemas live here, types are inferred. Anywhere we cross the
 * trust boundary (parsing the upstream response), we validate; past that,
 * the inferred type is the contract.
 *
 * Schemas are intentionally loose — PDNS has added fields between versions,
 * and a stricter `.strict()` would reject newer-server responses without
 * cause. We pin exactly the fields the app reads.
 */

import "server-only";
import { z } from "zod";

// =============================================================================
// Server info — GET /api/v1/servers/{id}
// =============================================================================

export const pdnsServerInfoSchema = z.object({
  type: z.string(),
  id: z.string(),
  url: z.string().optional(),
  daemon_type: z.string().optional(),
  /** Free-form version string; sometimes contains commit suffixes. */
  version: z.string(),
  config_url: z.string().optional(),
  zones_url: z.string().optional(),
});

export type PdnsServerInfo = z.infer<typeof pdnsServerInfoSchema>;

/**
 * Statistics from `GET /servers/{id}/statistics`. PDNS returns a
 * mixed-shape array — most are simple cumulative counters, a handful
 * are bucketed maps, the rest are rolling "top N" rings. The schema
 * preserves the discriminator via Zod's union so callers can switch
 * on `type`.
 */
const statisticItem = z.object({
  type: z.literal("StatisticItem"),
  name: z.string(),
  value: z.string(),
});
const mapStatisticItem = z.object({
  type: z.literal("MapStatisticItem"),
  name: z.string(),
  value: z.array(z.object({ name: z.string(), value: z.string() })),
});
const ringStatisticItem = z.object({
  type: z.literal("RingStatisticItem"),
  name: z.string(),
  size: z.string().optional(),
  value: z.array(z.object({ name: z.string(), value: z.string() })),
});
export const pdnsStatisticsSchema = z.array(
  z.discriminatedUnion("type", [statisticItem, mapStatisticItem, ringStatisticItem]),
);
export type PdnsStatisticsEntry = z.infer<typeof pdnsStatisticsSchema>[number];

// =============================================================================
// Zones — GET /api/v1/servers/{id}/zones (list) and .../zones/{zoneId} (detail)
// =============================================================================

/**
 * Zone kinds PowerDNS recognizes. PDNS 4.7+ adds `Producer` / `Consumer`
 * (catalog). Unknown kinds returned by a future PDNS pass through as the
 * raw string — we use `z.string()` rather than an enum so we don't fail on
 * a new value.
 */
export const pdnsZoneKindSchema = z.string();

export const pdnsZoneSummarySchema = z.object({
  /**
   * PDNS-assigned id used in the URL — the zone name URL-encoded (with the
   * trailing dot), e.g. `example.com.`. Always present on list responses.
   */
  id: z.string(),
  /** Canonical zone name including the trailing dot. */
  name: z.string(),
  /** "Zone" — discriminator the API includes on every record-bearing object. */
  type: z.literal("Zone").optional(),
  url: z.string().optional(),
  kind: pdnsZoneKindSchema,
  serial: z.number().int().nonnegative().optional(),
  /** `edited_serial` is the optimistic-concurrency token (legacy issue #141). */
  edited_serial: z.number().int().nonnegative().optional(),
  notified_serial: z.number().int().nonnegative().optional(),
  dnssec: z.boolean().optional(),
  account: z.string().optional(),
  masters: z.array(z.string()).optional(),
  /** Catalog membership (PDNS 4.7+). */
  catalog: z.string().optional(),
  /**
   * Zone-object metadata fields. PDNS surfaces SOA-EDIT, SOA-EDIT-API and
   * API-RECTIFY as fields on the zone object — they're NOT writable via
   * `/metadata/{kind}` in 4.9 (the per-kind endpoint's allowlist rejects
   * them with "Unsupported metadata kind"). The right write path is
   * `PUT /zones/{id}` with these body fields.
   */
  soa_edit: z.string().optional(),
  soa_edit_api: z.string().optional(),
  api_rectify: z.boolean().optional(),
  /**
   * TSIG keys securing AXFR, as zone-object fields (NOT the read-only
   * TSIG-ALLOW-AXFR / AXFR-MASTER-TSIG metadata kinds, which the per-kind API
   * rejects). `master_tsig_key_ids` = keys allowed to AXFR when this server is
   * primary; `slave_tsig_key_ids` = the key it signs AXFR with when secondary.
   * Values are TSIG key ids (= the key name on the gsqlite3/gmysql/gpgsql
   * backends). Set via `PUT /zones/{id}`. Optional — absent on older list rows.
   */
  master_tsig_key_ids: z.array(z.string()).optional(),
  slave_tsig_key_ids: z.array(z.string()).optional(),
});

export type PdnsZoneSummary = z.infer<typeof pdnsZoneSummarySchema>;

export const pdnsZoneListSchema = z.array(pdnsZoneSummarySchema);

/**
 * Detail response adds the `rrsets` array. We don't validate the RRsets at
 * the type layer here —(record editing) introduces a per-RRset
 * schema with per-type record validation.
 */
export const pdnsZoneDetailSchema = pdnsZoneSummarySchema.extend({
  rrsets: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        ttl: z.number().int().nonnegative(),
        records: z.array(
          z.object({
            content: z.string(),
            disabled: z.boolean().optional(),
          }),
        ),
        comments: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

export type PdnsZoneDetail = z.infer<typeof pdnsZoneDetailSchema>;

// =============================================================================
// Cryptokeys — GET /api/v1/servers/{id}/zones/{zone_id}/cryptokeys
// =============================================================================
//
// DNSSEC keys for a zone. The list response omits `privatekey` (it's only
// returned on POST or when `includeprivate=true` is set on the detail
// endpoint — which we don't do here for at-rest-secret hygiene). PDNS
// uses snake_case for all field names; we keep that convention rather
// than re-mapping, so consumers reading the schemas know exactly what
// the wire shape looks like.

export const pdnsCryptokeyTypeSchema = z.literal("Cryptokey");

/**
 * Key types per the PDNS docs:
 *   - "ksk" — Key Signing Key (signs the DNSKEY rrset only)
 *   - "zsk" — Zone Signing Key (signs other rrsets)
 *   - "csk" — Combined Signing Key (does both; common with modern algos)
 *
 * Unknown values returned by a future PDNS pass through as the raw
 * string rather than failing parse — same pattern as zone kinds.
 */
export const pdnsKeyTypeSchema = z.string();

export const pdnsCryptokeySummarySchema = z.object({
  type: pdnsCryptokeyTypeSchema.optional(),
  id: z.number().int().nonnegative(),
  keytype: pdnsKeyTypeSchema,
  active: z.boolean(),
  /**
   * Whether the key's DNSKEY record is published in the zone. PDNS adds
   * this in 4.5+; older servers may omit it — treat absence as
   * "unknown, assume published if active".
   */
  published: z.boolean().optional(),
  /** The DNSKEY record body (RDATA). */
  dnskey: z.string(),
  /**
   * Delegation Signer records — present for KSK/CSK so the operator can
   * hand them to their registrar. Empty for ZSKs (they're not at the
   * delegation point). Older PDNS servers may omit the field entirely.
   */
  ds: z.array(z.string()).optional(),
  /** CDS records, when generated. PDNS 4.5+. */
  cds: z.array(z.string()).optional(),
  /** DNSSEC algorithm name (e.g. "ECDSAP256SHA256"). PDNS 4.0+. */
  algorithm: z.string().optional(),
  /** Key size in bits. Meaningful for RSA; informational for EC. */
  bits: z.number().int().positive().optional(),
});

export type PdnsCryptokeySummary = z.infer<typeof pdnsCryptokeySummarySchema>;

export const pdnsCryptokeyListSchema = z.array(pdnsCryptokeySummarySchema);

// The detail endpoint returns the same fields. `privatekey` would
// appear here if we ever passed `includeprivate=true`, which we
// intentionally do not — handling the key material would require
// extending the at-rest secret pipeline beyond the rest of the design.
export const pdnsCryptokeyDetailSchema = pdnsCryptokeySummarySchema;

export type PdnsCryptokeyDetail = z.infer<typeof pdnsCryptokeyDetailSchema>;

// =============================================================================
// Zone metadata — GET /api/v1/servers/{id}/zones/{zone_id}/metadata
// =============================================================================
//
// Per-zone configuration the PDNS daemon honors at lookup / transfer time.
// Common kinds: ALSO-NOTIFY, ALLOW-AXFR-FROM, ALLOW-DNSUPDATE-FROM,
// TSIG-ALLOW-AXFR, AXFR-MASTER-TSIG, API-RECTIFY, NSEC3PARAM, SOA-EDIT,
// SOA-EDIT-API, PUBLISH-CDS, PUBLISH-CDNSKEY. Newer PDNS releases add
// more — we keep `kind` as a free `z.string()` so an unrecognized name
// returned by a future PDNS doesn't make the parse blow up.
//
// PDNS uses singular `kind` and plural `metadata` (array of strings)
// consistently — even when the conceptual value is a single string,
// it's still wrapped in a one-element array.

export const pdnsMetadataKindSchema = z.string();

export const pdnsMetadataSchema = z.object({
  type: z.literal("Metadata").optional(),
  kind: pdnsMetadataKindSchema,
  metadata: z.array(z.string()),
});

export type PdnsMetadata = z.infer<typeof pdnsMetadataSchema>;

export const pdnsMetadataListSchema = z.array(pdnsMetadataSchema);

// =============================================================================
// TSIG keys — GET /api/v1/servers/{id}/tsigkeys
// =============================================================================
//
// Shared-secret keys used to authenticate AXFR / IXFR / NOTIFY between
// primaries and secondaries. The list endpoint typically returns just
// {id, name, algorithm} without the secret; the detail endpoint
// includes `key` (the base64-encoded HMAC secret).
//
// We model the two shapes separately so the type system enforces
// "secret is not present in list rows" — preventing accidental log
// statements that try to read `row.key` on a list element.

const TSIG_ALGORITHMS = [
  "hmac-md5",
  "hmac-sha1",
  "hmac-sha224",
  "hmac-sha256",
  "hmac-sha384",
  "hmac-sha512",
] as const;

/**
 * PDNS accepts the algorithm names above. Unknown / future values
 * (PDNS may add more) pass through as the raw string rather than
 * failing parse.
 */
export const pdnsTsigAlgorithmSchema = z.union([z.enum(TSIG_ALGORITHMS), z.string()]);

export const pdnsTsigKeySummarySchema = z.object({
  type: z.literal("TSIGKey").optional(),
  id: z.string(),
  name: z.string(),
  algorithm: pdnsTsigAlgorithmSchema,
});

export type PdnsTsigKeySummary = z.infer<typeof pdnsTsigKeySummarySchema>;

export const pdnsTsigKeyListSchema = z.array(pdnsTsigKeySummarySchema);

/**
 * Detail shape. Includes `key` — the base64-encoded shared secret.
 * This MUST NOT be logged, returned to non-privileged actors, or
 * persisted anywhere outside PDNS itself. The audit-log redactor
 * already covers field names like `key` / `secret`; callers that
 * pass this object into `appendAudit` snapshots get automatic
 * redaction. Direct loggers must avoid passing the field at all.
 */
export const pdnsTsigKeyDetailSchema = pdnsTsigKeySummarySchema.extend({
  key: z.string(),
});

export type PdnsTsigKeyDetail = z.infer<typeof pdnsTsigKeyDetailSchema>;

// =============================================================================
// Autoprimaries — GET /api/v1/servers/{id}/autoprimaries
// =============================================================================
//
// Trusted upstream primaries from which this PDNS server will accept
// automatic slave-zone creation via incoming NOTIFY. Each row is the
// tuple (ip, nameserver, account?). PDNS deduplicates by (ip,
// nameserver) so the delete path keys on that pair, not a synthetic
// id. `account` is an operator-supplied free-form label PDNS records
// for grouping/billing — never authoritative DNS data.

export const pdnsAutoprimarySchema = z.object({
  ip: z.string(),
  nameserver: z.string(),
  account: z.string().optional(),
});

export type PdnsAutoprimary = z.infer<typeof pdnsAutoprimarySchema>;

export const pdnsAutoprimaryListSchema = z.array(pdnsAutoprimarySchema);

// =============================================================================
// Daemon config (read-only) — GET /servers/{id}/config
// =============================================================================

/**
 * One global daemon setting as PowerDNS reports it on the read-only `/config`
 * endpoint (the file-based `pdns.conf` values; the API can't change them).
 * Values are always strings (`"yes"`, `"localhost"`, …).
 */
export const pdnsConfigSettingSchema = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
});
export type PdnsConfigSetting = z.infer<typeof pdnsConfigSettingSchema>;
export const pdnsConfigSchema = z.array(pdnsConfigSettingSchema);

/**
 * What a backend's daemon is OBSERVED to be willing/able to do, derived from
 * its read-only `/config` on each version probe (ADR-0014). This is the
 * per-daemon truth the app uses instead of an operator-declared `role`: a
 * single daemon can be primary AND secondary at once. `null` in storage means
 * "never observed yet".
 *
 * Lives here (the PDNS protocol layer), like `PdnsVersionCache`, so the DB
 * schema can import it for its `.$type<>()` without crossing the
 * `lib/pdns → lib/db` boundary.
 */
export interface PdnsDaemonCapabilities {
  /** `api=yes` — the HTTP API is enabled (definitionally true if we read this). */
  api: boolean;
  /** `primary`/`master`=yes — sends NOTIFY + serves AXFR for its master zones. */
  primary: boolean;
  /** `secondary`/`slave`=yes — initiates AXFR for its slave zones. */
  secondary: boolean;
  /** `autosecondary`/`superslave`=yes — auto-creates slave zones from NOTIFY. */
  autosecondary: boolean;
  /** Storage backends parsed from `launch`, e.g. ["gsqlite3", "lmdb"]. */
  backends: string[];
  /** Whether DNSSEC is enabled on any backend (`*-dnssec=yes`, or lmdb). */
  dnssec: boolean;
  /**
   * Count of configured autoprimaries (PowerDNS "supermasters") observed from
   * `GET /autoprimaries`. Refreshed alongside the rest of the snapshot. Lets the
   * health evaluator flag an `autosecondary`/autoprimary intent mismatch without
   * an extra per-cycle API call. Optional: absent on snapshots taken before this
   * field existed, or when the autoprimary read failed.
   */
  autoprimaryCount?: number;
  /** When this snapshot was taken (ISO timestamp). */
  fetchedAt: string;
}

// =============================================================================
// Cached version snapshot (lives in the pdns_servers.version_cache JSON column)
// =============================================================================

/**
 * Snapshot of a PowerDNS backend's version + derived capability flags.
 * Populated by `lib/pdns/version.ts` after a successful version probe.
 * `null` in storage means "never probed yet".
 *
 * Lives in this file (the PDNS protocol layer) rather than in
 * `lib/db/schema/pdns-servers.ts` so the protocol adapter doesn't have
 * to cross the `lib/pdns → lib/db` import-boundary rule. The DB schema
 * imports it from here for its `.$type<>()` annotation — the reverse
 * direction is allowed.
 */
export interface PdnsVersionCache {
  /** Free-form version string as reported by PDNS, e.g. "5.0.4". */
  version: string;
  /** Server-id within the PDNS API surface — almost always "localhost". */
  serverId: string;
  /** Parsed semantic-version triple for capability comparisons. */
  parsed: { major: number; minor: number; patch: number };
  /** Capability flags derived from the version. */
  capabilities: {
    /** EXTEND/PRUNE changetypes (≥ 4.9.12 / 5.0.2). */
    supportsExtendPrune: boolean;
    /** Catalog zones (producer/consumer) (≥ 4.7). */
    supportsCatalogZones: boolean;
    /** Views / Networks split-horizon (≥ 5.0). */
    supportsViews: boolean;
    /**
     * TSIG-key management over the HTTP API — list/get (incl. the secret),
     * create with an imported `key`, delete (≥ 4.1). Gates the API-driven
     * "install on secondaries" flow; older daemons fall back to manual pdnsutil.
     */
    supportsTsigApi: boolean;
  };
  /** When this snapshot was taken (ISO timestamp). */
  fetchedAt: string;
}
