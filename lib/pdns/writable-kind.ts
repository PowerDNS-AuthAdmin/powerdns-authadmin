/**
 * lib/pdns/writable-kind.ts
 *
 * Whether a zone's CONTENT (records + DNSSEC) is editable - decided by the
 * zone's PowerDNS `kind`, NOT by the backend's app-level role. A single PDNS
 * server can be authoritative for some zones and a mirror for others, so
 * read-only-ness is a per-zone property:
 *
 *   - Master / Primary / Native            → authoritative, content editable.
 *   - Slave / Secondary / Consumer         → AXFR mirror: records + DNSSEC are
 *                                            owned by the primary and
 *                                            overwritten on the next transfer,
 *                                            so editing them here is futile.
 *   - Producer                             → catalog zone: PowerDNS generates
 *                                            its member records from the zones
 *                                            that name it, so a hand edit is
 *                                            meaningless at best (#209).
 *
 * Replication CONFIG (the zone's `masters`, transfer metadata) and removing
 * the mirror are NOT gated here - those are legitimate on a mirror.
 *
 * Pure + dependency-light (only the error type) so it's usable from server
 * components, route handlers, and client code alike.
 */

import { ConflictError } from "@/lib/errors";
import { catalogRole, isMirrorKind } from "./zone-kinds";

/** True for AXFR-mirror kinds whose records/DNSSEC come from the primary. */
export function isReadOnlyZoneKind(kind: string): boolean {
  return isMirrorKind(kind);
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
  const producer = catalogRole(kind) === "producer";
  return {
    rrsets: !mirror && !producer,
    dnssec: !mirror && !producer,
    metadata: true,
    masters: mirror,
    axfrRetrieve: mirror,
    delete: true,
  };
}

/** Throw (409) when a zone-content write targets an AXFR-mirror or catalog Producer zone. */
export function assertEditableZoneKind(kind: string): void {
  if (catalogRole(kind) === "producer") {
    throw new ConflictError(
      "This is a catalog Producer zone - PowerDNS generates its records from the zones that " +
        "name it as their catalog, so they can't be edited here. Change a zone's catalog in its settings instead.",
    );
  }
  if (isReadOnlyZoneKind(kind)) {
    throw new ConflictError(
      `This is a ${kind} zone - its records and DNSSEC are managed by its primary over AXFR ` +
        `and can't be edited here. (You can still change the mirror's masters and transfer metadata.)`,
    );
  }
}
