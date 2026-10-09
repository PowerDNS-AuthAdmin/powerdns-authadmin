/**
 * lib/rbac/protected-rrsets.ts
 *
 * Two RRsets in every zone are not "records" in the sense a self-service
 * editor means it - they are the zone's standing in DNS:
 *
 *   - **SOA** at the apex: authority, the responsible mailbox, and the
 *     refresh/retry/expire/minimum timers every secondary obeys. Get it
 *     wrong and transfers stall or the zone expires off the secondaries.
 *   - **NS** at the apex: the delegation. Remove it and the zone stops
 *     being served, however healthy the rest of the records are.
 *
 * Both used to be reachable with plain `record.update`, which is the
 * permission a hosting provider hands their customers so they can point
 * an A record at a new box (#119). This module names the extra
 * permission each one costs, so the RRset write path and the record
 * editor agree on the answer without either re-deriving it.
 *
 * Deliberately pure (no `server-only`, only the equally pure zone-name
 * helper): the record editor is a client component and needs the same
 * predicate to decide which rows to lock, and the unit tests want it
 * without a DB.
 *
 * NS *below* the apex is an ordinary record - a child delegation is
 * content, not this zone's own authority - so it needs only `record.*`.
 *
 * ADR-0023 records why the SOA is modelled as its own resource (so
 * `soa.update` REPLACES the record permission) while the apex NS stays a
 * record with an extra cost (`record.update.apex-ns` is ADDITIVE).
 */

import { canonicalZoneName } from "@/lib/dns/zone-name";

/**
 * Extra permission a write to this RRset costs, or `null` when the
 * RRset is an ordinary record.
 *
 * `soa.update` REPLACES the `record.*` requirement (SOA is its own
 * resource, with its own editor and its own read permission).
 * `record.update.apex-ns` is ADDITIVE - an apex NS write still needs
 * the matching `record.create`/`record.update`/`record.delete`.
 */
export type ProtectedRRsetPermission = "soa.update" | "record.update.apex-ns";

/**
 * Compare two DNS names for equality the way the rest of the app stores
 * them: lowercased, with exactly one trailing dot. Callers pass names in
 * whatever form the request carried; PowerDNS is case-insensitive here
 * and inconsistent about the trailing dot depending on the endpoint.
 *
 * Full `toLowerCase()` rather than an ASCII-only fold (which is all RFC
 * 4343 defines for DNS) on purpose, for two reasons. It is byte-for-byte
 * what `normalizeZoneId` and the RRset route's `normalizeName` already
 * do, so this can never fold LESS than the value it is handed - folding
 * less is the direction that misses an apex match and lets a write
 * through. And where Unicode folds more than DNS would (U+212A KELVIN
 * SIGN onto "k", say), the extra match errs toward "this RRset is
 * protected", i.e. toward denying a write that did not need the
 * permission. Names that reach here are punycode for anything non-ASCII
 * anyway, so neither case is reachable with a real zone.
 */
function sameName(a: string, b: string): boolean {
  return canonicalZoneName(a) === canonicalZoneName(b);
}

/** True when `name` is the zone apex (`@`, empty, or the zone name itself). */
export function isZoneApex(name: string, zoneName: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "@") return true;
  return sameName(trimmed, zoneName);
}

/**
 * The extra permission this (name, type) write costs on `zoneName`, or
 * `null` for an ordinary record.
 *
 * @example
 *   protectedRRsetPermission("example.com.", "SOA", "example.com.")   // "soa.update"
 *   protectedRRsetPermission("@", "NS", "example.com.")               // "record.update.apex-ns"
 *   protectedRRsetPermission("sub.example.com.", "NS", "example.com.") // null - child delegation
 *   protectedRRsetPermission("www.example.com.", "A", "example.com.")  // null
 */
export function protectedRRsetPermission(
  name: string,
  type: string,
  zoneName: string,
): ProtectedRRsetPermission | null {
  const upperType = type.trim().toUpperCase();
  // A SOA can only legally exist at the apex, but don't make the answer
  // depend on that: any SOA write is an SOA write.
  if (upperType === "SOA") return "soa.update";
  if (upperType === "NS" && isZoneApex(name, zoneName)) return "record.update.apex-ns";
  return null;
}
