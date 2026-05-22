/**
 * lib/validators/rr-types/index.ts
 *
 * Registry of per-type validators. Adding a new type:
 *   1. Add a file alongside this one.
 *   2. Import + register here.
 *   3. Add the type code to `SUPPORTED_TYPES` if it should appear in the
 *      editor's type dropdown.
 *
 * Unknown types fall through to `makeGenericValidator` which enforces only
 * the universal constraints and warns the operator that they're outside
 * type-aware checking.
 */

import { aValidator } from "./a";
import { aaaaValidator } from "./aaaa";
import { caaValidator } from "./caa";
import { cnameValidator } from "./cname";
import { dnameValidator } from "./dname";
import { dsValidator } from "./ds";
import { makeGenericValidator } from "./generic";
import { mxValidator } from "./mx";
import { naptrValidator } from "./naptr";
import { nsValidator } from "./ns";
import { openpgpkeyValidator } from "./openpgpkey";
import { ptrValidator } from "./ptr";
import { smimeaValidator } from "./smimea";
import { srvValidator } from "./srv";
import { sshfpValidator } from "./sshfp";
import { httpsValidator, svcbValidator } from "./svcb";
import { tlsaValidator } from "./tlsa";
import { txtValidator } from "./txt";
import { uriValidator } from "./uri";
import type { RRTypeValidator } from "./types";

const REGISTRY = new Map<string, RRTypeValidator>(
  [
    aValidator,
    aaaaValidator,
    cnameValidator,
    nsValidator,
    mxValidator,
    ptrValidator,
    srvValidator,
    txtValidator,
    caaValidator,
    dsValidator,
    sshfpValidator,
    tlsaValidator,
    naptrValidator,
    dnameValidator,
    smimeaValidator,
    uriValidator,
    openpgpkeyValidator,
    svcbValidator,
    httpsValidator,
  ].map((v) => [v.type, v]),
);

/**
 * Types presented in the type dropdown by default. SOA is intentionally
 * absent — operators manage SOA via the dedicated panel, not as a record.
 * Add `HTTPS`, `SVCB`, `DNSKEY`, etc. once they have typed validators.
 */
export const SUPPORTED_TYPES: readonly string[] = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "PTR",
  "SRV",
  "TXT",
  "CAA",
  "DS",
  "SSHFP",
  "TLSA",
  "NAPTR",
  "DNAME",
  "SMIMEA",
  "URI",
  "OPENPGPKEY",
  "SVCB",
  "HTTPS",
];

/**
 * Record types that belong in a reverse zone. PTR is the primary
 * purpose; NS / DNAME / CNAME cover RFC 2317-style classless reverse
 * delegations; TXT is occasionally used for ownership / contact notes.
 * Everything else (A, MX, SRV, …) is semantically nonsensical in an
 * `in-addr.arpa` / `ip6.arpa` zone and would only ever land there by
 * accident.
 */
export const REVERSE_ZONE_TYPES: readonly string[] = ["PTR", "NS", "DNAME", "CNAME", "TXT"];

/**
 * Forward zones get the full menu minus PTR — PTR in a forward zone
 * is technically valid but a strong smell, and we don't surface it to
 * keep the dropdown intentional.
 */
export const FORWARD_ZONE_TYPES: readonly string[] = SUPPORTED_TYPES.filter((t) => t !== "PTR");

/**
 * Allow-list of record types the editor should expose for `zoneName`.
 * Reverse zones are detected by `in-addr.arpa` / `ip6.arpa` suffix
 * (case-insensitive, trailing-dot tolerant). Unknown zones fall back
 * to the forward menu.
 *
 * Callers that need to edit a legacy record whose type is outside the
 * allow-list (e.g. an A record on a reverse zone) should merge in the
 * existing type so the dropdown doesn't lose it.
 */
export function typesForZone(zoneName: string): readonly string[] {
  // Local copy of zone-kind detection to keep this module free of
  // cross-package imports; mirrored from lib/dns/zone-kind.ts.
  const n = zoneName.toLowerCase().replace(/\.$/, "");
  if (n === "in-addr.arpa" || n.endsWith(".in-addr.arpa")) return REVERSE_ZONE_TYPES;
  if (n === "ip6.arpa" || n.endsWith(".ip6.arpa")) return REVERSE_ZONE_TYPES;
  return FORWARD_ZONE_TYPES;
}

/** Sensible default record type for a fresh record in `zoneName`. */
export function defaultTypeForZone(zoneName: string): string {
  return typesForZone(zoneName)[0] ?? "A";
}

/**
 * Resolve the validator for a given type. Unknown types get a generic
 * validator instance that warns about the missing type-aware checks.
 */
export function getRRTypeValidator(type: string): RRTypeValidator {
  const upper = type.toUpperCase();
  return REGISTRY.get(upper) ?? makeGenericValidator(upper);
}

export type { RRTypeValidator, RRValidationIssue, RRValidationResult } from "./types";
export { hasErrors, hasIssues } from "./types";
