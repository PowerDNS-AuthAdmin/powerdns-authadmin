/**
 * app/api/admin/pdns/zones/[zoneId]/rrsets/_shared.ts
 *
 * Helpers the RRset PATCH route and its dry-run sibling (`ptr-plan`) share:
 * name canonicalisation, the before-state fetch and the audit-snapshot
 * shaping. A route file may only export HTTP handlers, hence the underscore
 * module next to it (the MCP server uses the same convention).
 */

import type { PdnsClient } from "@/lib/pdns/client";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

/**
 * Drop duplicate-content records from an RRset. PowerDNS rejects an RRset that
 * carries the same content twice ("Duplicate record in RRset …"), which happens
 * naturally when an operator edits one record to a value another record in the
 * same RRset already holds. Deduping makes that edit MERGE - the same net result
 * the Review-changes diff already shows - instead of failing on apply. First
 * occurrence wins (preserves order); a present `disabled:false` beats a later
 * disabled duplicate so a merge doesn't silently disable the record.
 */
export function dedupeRecordsByContent<T extends { content: string; disabled?: boolean }>(
  records: readonly T[],
): T[] {
  const byContent = new Map<string, T>();
  for (const r of records) {
    const existing = byContent.get(r.content);
    if (!existing) byContent.set(r.content, r);
    else if (existing.disabled && !r.disabled) byContent.set(r.content, r);
  }
  return [...byContent.values()];
}

/**
 * Normalize a user-typed RRset name. Accepts:
 *   - "@" → zone apex
 *   - relative ("www") → www.zone.
 *   - fully-qualified ("www.example.com.") → as-is
 */
export function normalizeName(raw: string, zoneName: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zoneName;
  if (trimmed.endsWith(".")) return trimmed;
  return `${trimmed}.${zoneName}`;
}

/**
 * Pull a comments array off a PDNS rrset snapshot. PDNS returns the
 * field as an array of `{ content, account, modified_at }` objects, but
 * older / proxied responses may omit it. We don't reshape the entries -
 * we forward whatever PDNS gave us so the PATCH round-trip preserves
 * them byte-for-byte.
 */
export function readComments(rrset: unknown): Array<Record<string, unknown>> {
  if (!rrset || typeof rrset !== "object") return [];
  const raw = (rrset as { comments?: unknown }).comments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
}

/**
 * Normalize a PDNS rrset shape for the audit `before` snapshot - always
 * including `comments: []` when PDNS didn't supply the field, so the
 * before/after diff doesn't show a spurious "comments removed" line.
 */
export function normalizeRRsetForAudit(rrset: unknown): Record<string, unknown> {
  if (!rrset || typeof rrset !== "object") return { comments: [] };
  const r = rrset as Record<string, unknown>;
  return { ...r, comments: readComments(rrset) };
}

/**
 * Above this many distinct RRsets in one batch, one full zone GET is cheaper
 * than a filtered GET per RRset (each is a round-trip plus a backend query).
 */
export const MAX_FILTERED_RRSET_FETCHES = 3;

/**
 * The zone state the patch is checked against: kind, metadata and the RRsets
 * the batch touches (for the conflict hashes, the audit `before` snapshots and
 * the comment carry-through). A typical edit touches one RRset, so on a daemon
 * with the `rrset_name` filter we fetch the zone header without records plus
 * one filtered GET per touched RRset instead of transferring every record of
 * the zone - twice per edit, once here and once for the after-snapshot - which
 * is what made single-record edits on large zones slow. Larger batches and
 * older daemons fall back to the full GET.
 */
export async function loadZoneBefore(
  client: PdnsClient,
  zoneName: string,
  changes: ReadonlyArray<{ name: string; type: string }>,
): Promise<PdnsZoneDetail> {
  const keys = new Map<string, { name: string; type: string }>();
  for (const change of changes) {
    const name = normalizeName(change.name, zoneName);
    keys.set(`${name}|${change.type}`, { name, type: change.type });
  }
  if (!client.supports("supportsRrsetFilter") || keys.size > MAX_FILTERED_RRSET_FETCHES) {
    return client.getZone(zoneName);
  }
  const [header, ...parts] = await Promise.all([
    client.getZone(zoneName, { rrsets: false }),
    ...[...keys.values()].map((k) =>
      client.getZone(zoneName, { rrsetName: k.name, rrsetType: k.type }),
    ),
  ]);
  return { ...header, rrsets: parts.flatMap((p) => p.rrsets ?? []) };
}

/**
 * Fetch specific RRsets of a zone by owner name, using the filtered GET when the
 * daemon has it and the list is short, else one full GET. Returns a map keyed by
 * `name|TYPE`.
 */
export async function loadRRsets(
  client: PdnsClient,
  zoneName: string,
  keys: ReadonlyArray<{ name: string; type: string }>,
): Promise<Map<string, NonNullable<PdnsZoneDetail["rrsets"]>[number]>> {
  const out = new Map<string, NonNullable<PdnsZoneDetail["rrsets"]>[number]>();
  if (keys.length === 0) return out;
  let rrsets: NonNullable<PdnsZoneDetail["rrsets"]>;
  if (!client.supports("supportsRrsetFilter") || keys.length > MAX_FILTERED_RRSET_FETCHES) {
    rrsets = (await client.getZone(zoneName)).rrsets ?? [];
  } else {
    const parts = await Promise.all(
      keys.map((k) => client.getZone(zoneName, { rrsetName: k.name, rrsetType: k.type })),
    );
    rrsets = parts.flatMap((p) => p.rrsets ?? []);
  }
  for (const rr of rrsets) out.set(`${rr.name}|${rr.type}`, rr);
  return out;
}
