/**
 * lib/pdns/zone-kinds.ts
 *
 * The one classification of PowerDNS zone `kind` values. PDNS spells them
 * capitalised (`Master`, `Slave`, `Native`, `Producer`, `Consumer`) and, since
 * 4.5, also accepts `Primary`/`Secondary`; comparisons here are
 * case-insensitive so either spelling and any cached form match.
 *
 *   - mirror kinds      - Slave / Secondary / Consumer: the zone's content is
 *                         pulled from a primary over AXFR and overwritten on
 *                         the next transfer.
 *   - transferred kinds - Master / Primary / Producer: PDNS sends the zone out
 *                         over AXFR and NOTIFYs its secondaries. A catalog
 *                         Producer zone is transferred exactly like a Master
 *                         zone (its Consumers are ordinary secondaries of it).
 *   - Native            - neither: no DNS-protocol replication at all.
 *
 * Six copies of these sets used to live in six modules with three different
 * memberships - `createZoneAndNotify` skipped the NOTIFY on a Producer zone
 * that the DNSSEC plan (correctly) treated as transferred. Every caller now
 * asks this module.
 *
 * Pure and import-free so server components, route handlers, client code and
 * tests can all use it.
 */

const MIRROR_KINDS: ReadonlySet<string> = new Set(["slave", "secondary", "consumer"]);
const TRANSFERRED_KINDS: ReadonlySet<string> = new Set(["master", "primary", "producer"]);

/** True for AXFR-mirror kinds whose records/DNSSEC come from the primary. */
export function isMirrorKind(kind: string): boolean {
  return MIRROR_KINDS.has(kind.toLowerCase());
}

/** True for kinds PowerDNS sends out over AXFR and NOTIFY (incl. catalog Producer). */
export function isTransferredKind(kind: string): boolean {
  return TRANSFERRED_KINDS.has(kind.toLowerCase());
}
