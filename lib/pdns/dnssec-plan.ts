/**
 * lib/pdns/dnssec-plan.ts
 *
 * Pure decisions behind the zone-level DNSSEC actions (enable / disable /
 * rectify): which zone settings to send, which warnings to surface, and how
 * to read the DS set back out of the cryptokeys. The routes in
 * app/api/admin/pdns/zones/[zoneId]/dnssec and .../rectify do the I/O.
 *
 * Why enabling goes through `PUT /zones/{id}` with `dnssec: true` rather than
 * `POST /cryptokeys`: the zone PUT adds PowerDNS' default keys, rectifies
 * (ordername + auth, without which NSEC/NSEC3 denial is broken) and bumps the
 * serial in one backend transaction. Adding a key through `/cryptokeys` does
 * none of the last two.
 */

/**
 * SOA-EDIT applied on enable when the zone is transferred and has none.
 *
 * A presigned secondary serves the RRSIGs it was sent until the next AXFR.
 * PowerDNS rotates signatures weekly with a three-week validity, so without a
 * weekly serial change the secondary's copies eventually expire and
 * validators see the zone as bogus. INCREMENT-WEEKS advances the served serial
 * every week, which makes the secondaries re-transfer fresh signatures.
 */
export const DEFAULT_SIGNED_SOA_EDIT = "INCREMENT-WEEKS";

import { isTransferredKind } from "./zone-kinds";
import { sameZoneName } from "@/lib/dns/zone-name";

// Re-exported under their historical names for the DNSSEC routes; the
// definitions live in the shared classification modules.
export { isTransferredKind, sameZoneName };

export interface DnssecZoneFacts {
  kind: string;
  soa_edit?: string | undefined;
  rrsets?: ReadonlyArray<{ type: string }> | undefined;
}

export interface EnableRequest {
  /** undefined = choose automatically; "" = leave SOA-EDIT unset. */
  soaEdit?: string | undefined;
  apiRectify?: boolean | undefined;
  /** NSEC3 parameters, e.g. "1 0 0 -". Omitted = NSEC. */
  nsec3param?: string | undefined;
  nsec3narrow?: boolean | undefined;
}

export interface EnablePlan {
  settings: {
    dnssec: true;
    api_rectify: boolean;
    soa_edit?: string;
    nsec3param?: string;
    nsec3narrow?: boolean;
  };
  /** True when the zone reaches secondaries - drives the serial bump + NOTIFY. */
  replicated: boolean;
  warnings: string[];
}

/**
 * `hasMirrors` = a managed backend mirrors this zone. A Master/Primary zone
 * counts as replicated even without one, since its secondaries may be outside
 * this app (a third-party secondary DNS service, say).
 */
export function planDnssecEnable(
  zone: DnssecZoneFacts,
  hasMirrors: boolean,
  req: EnableRequest = {},
): EnablePlan {
  const replicated = hasMirrors || isTransferredKind(zone.kind);
  const currentSoaEdit = zone.soa_edit ?? "";

  let soaEdit: string | undefined;
  if (req.soaEdit !== undefined) {
    if (req.soaEdit !== currentSoaEdit) soaEdit = req.soaEdit;
  } else if (replicated && currentSoaEdit === "") {
    soaEdit = DEFAULT_SIGNED_SOA_EDIT;
  }

  const settings: EnablePlan["settings"] = {
    dnssec: true,
    api_rectify: req.apiRectify ?? true,
    ...(soaEdit !== undefined ? { soa_edit: soaEdit } : {}),
    ...(req.nsec3param !== undefined ? { nsec3param: req.nsec3param } : {}),
    ...(req.nsec3narrow !== undefined ? { nsec3narrow: req.nsec3narrow } : {}),
  };

  const effectiveSoaEdit = soaEdit ?? currentSoaEdit;
  return {
    settings,
    replicated,
    warnings: signedZoneWarnings({ ...zone, soa_edit: effectiveSoaEdit }, replicated, {
      apiRectify: settings.api_rectify,
    }),
  };
}

/**
 * Operator-facing warnings for a signed (or about-to-be-signed) zone.
 * Shared by the enable response and the DNSSEC tab.
 */
export function signedZoneWarnings(
  zone: DnssecZoneFacts,
  replicated: boolean,
  opts: { apiRectify?: boolean | undefined } = {},
): string[] {
  const out: string[] = [];
  const types = new Set((zone.rrsets ?? []).map((r) => r.type.toUpperCase()));

  if (replicated && (zone.soa_edit ?? "") === "") {
    out.push(
      "SOA-EDIT is not set. Presigned secondaries only re-transfer when the served serial changes, so their signatures expire (about three weeks) unless the zone is edited regularly. Set SOA-EDIT to INCREMENT-WEEKS.",
    );
  }
  if (opts.apiRectify === false) {
    out.push(
      "API-RECTIFY is off: record edits through the API won't rectify the zone, which breaks NSEC/NSEC3 denial until you rectify. Leave it on unless you rectify another way.",
    );
  }
  if (replicated && types.has("LUA")) {
    out.push(
      "The zone has LUA records. PowerDNS transfers them unexpanded and a presigned secondary can't sign the answers it computes from them, so validating resolvers will see those names as bogus on the secondaries. Keep LUA records out of signed zones served by presigned secondaries.",
    );
  }
  if (replicated && types.has("ALIAS")) {
    out.push(
      "The zone has ALIAS records. A presigned secondary can't sign the addresses an ALIAS expands to; set outgoing-axfr-expand-alias=yes on the primary so they are transferred expanded and signed (their values then only refresh on the next transfer).",
    );
  }
  return out;
}

/**
 * The SOA content with its serial advanced by one (RFC 1982 wrap, skipping 0).
 * Returns null if the content doesn't look like SOA RDATA.
 */
export function bumpSoaSerial(content: string): string | null {
  const fields = content.trim().split(/\s+/);
  if (fields.length !== 7) return null;
  const serial = Number(fields[2]);
  if (!Number.isInteger(serial) || serial < 0 || serial > 0xffffffff) return null;
  const next = (serial + 1) % 0x100000000;
  fields[2] = String(next === 0 ? 1 : next);
  return fields.join(" ");
}

export interface CryptokeyLike {
  keytype: string;
  active: boolean;
  published?: boolean | undefined;
  ds?: string[] | undefined;
}

// DS digest types not to hand a registrar: SHA-1 (1) and GOST (3). RFC 8624
// says SHA-1 MUST NOT be used for DS, and many registrars warn on or refuse it.
const DEPRECATED_DS_DIGESTS = new Set(["1", "3"]);

/**
 * DS records to publish at the parent: from every active, published KSK/CSK,
 * minus deprecated digest types. PowerDNS lists each key's DS in SHA-1,
 * SHA-256 and SHA-384; SHA-256 (digest type 2) is the one registrars expect.
 * The per-key `ds` arrays still carry everything PowerDNS returns.
 */
export function dsRecordsToPublish(keys: readonly CryptokeyLike[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const sep = k.keytype === "ksk" || k.keytype === "csk";
    if (!sep || !k.active || k.published === false) continue;
    for (const ds of k.ds ?? []) {
      // keytag algorithm digest-type digest
      const digestType = ds.trim().split(/\s+/)[2];
      if (digestType !== undefined && !DEPRECATED_DS_DIGESTS.has(digestType)) out.push(ds);
    }
  }
  return out;
}
