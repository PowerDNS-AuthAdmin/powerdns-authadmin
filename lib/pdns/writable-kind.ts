/**
 * lib/pdns/writable-kind.ts
 *
 * Whether a zone's CONTENT (records + DNSSEC) is editable - decided by the
 * zone's PowerDNS `kind`, NOT by the backend's app-level role. A single PDNS
 * server can be authoritative for some zones and a mirror for others, so
 * read-only-ness is a per-zone property:
 *
 *   - Master / Primary / Native / Producer → authoritative, content editable.
 *   - Slave / Secondary / Consumer         → AXFR mirror: records + DNSSEC are
 *                                            owned by the primary and
 *                                            overwritten on the next transfer,
 *                                            so editing them here is futile.
 *
 * Replication CONFIG (the zone's `masters`, transfer metadata) and removing
 * the mirror are NOT gated here - those are legitimate on a mirror.
 *
 * Pure + dependency-light (only the error type) so it's usable from server
 * components, route handlers, and client code alike.
 */

import { ConflictError } from "@/lib/errors";

const READ_ONLY_KINDS = new Set(["slave", "secondary", "consumer"]);

/** True for AXFR-mirror kinds whose records/DNSSEC come from the primary. */
export function isReadOnlyZoneKind(kind: string): boolean {
  return READ_ONLY_KINDS.has(kind.toLowerCase());
}

/** The operations PowerDNS permits on a zone, decided by its `kind`. */
export interface ZoneOps {
  /** Edit record sets - the zone's actual DNS content. */
  rrsets: boolean;
  /** Manage DNSSEC keys / online signing. */
  dnssec: boolean;
  /** Edit per-zone metadata (transfer config, SOA-EDIT-API, ALSO-NOTIFY, …). */
  metadata: boolean;
  /** Edit the `masters` list - where a mirror pulls its AXFR from. */
  masters: boolean;
  /** Trigger an immediate AXFR retrieve from the primary. */
  axfrRetrieve: boolean;
  /** Remove the zone from this backend. */
  delete: boolean;
}

/**
 * Resolve the editable operations for a zone from its `kind` (ADR-0014). An
 * AXFR mirror (Slave/Secondary/Consumer) has its records + DNSSEC owned by the
 * primary and overwritten on transfer, so those are read-only - but the
 * mirror's own replication config (masters, metadata), a manual retrieve, and
 * removing the mirror are all legitimate writes. Authoritative kinds
 * (Native/Master/Primary/Producer) own their content and have no upstream to
 * retrieve from, so masters/retrieve are meaningless there.
 */
export function zoneCapabilities(kind: string): ZoneOps {
  const mirror = isReadOnlyZoneKind(kind);
  return {
    rrsets: !mirror,
    dnssec: !mirror,
    metadata: true,
    masters: mirror,
    axfrRetrieve: mirror,
    delete: true,
  };
}

/** Throw (409) when a zone-content write targets an AXFR-mirror zone. */
export function assertEditableZoneKind(kind: string): void {
  if (isReadOnlyZoneKind(kind)) {
    throw new ConflictError(
      `This is a ${kind} zone - its records and DNSSEC are managed by its primary over AXFR ` +
        `and can't be edited here. (You can still change the mirror's masters and transfer metadata.)`,
    );
  }
}
