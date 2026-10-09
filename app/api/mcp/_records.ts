/**
 * app/api/mcp/_records.ts
 *
 * Pure helpers behind the MCP tools: name canonicalisation and the
 * RRset → row flattening the tools present to a model. No I/O, so the
 * behaviour is unit-tested without a PowerDNS.
 */

import { normalizeZoneId } from "@/lib/pdns/client";

export interface RecordRow {
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled: boolean;
}

export interface RRsetLike {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}

/** Zone names arrive however the model typed them; PowerDNS wants lowercase + trailing dot. */
export function canonicalZone(input: string): string {
  return normalizeZoneId(input.trim());
}

/**
 * Owner names the way the web editor accepts them: `@` or empty for the
 * apex, a relative label (`www`), or an absolute name ending in `.`.
 */
export function canonicalName(input: string, zone: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zone;
  if (trimmed.endsWith(".")) return trimmed;
  if (trimmed === zone.slice(0, -1)) return zone;
  return `${trimmed}.${zone}`;
}

export function flattenRrsets(rrsets: readonly RRsetLike[]): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const rr of rrsets) {
    for (const r of rr.records) {
      rows.push({
        name: rr.name,
        type: rr.type,
        ttl: rr.ttl,
        content: r.content,
        disabled: r.disabled === true,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.type.localeCompare(b.type) ||
      a.content.localeCompare(b.content),
  );
}

export function filterRows(
  rows: readonly RecordRow[],
  filter: { name?: string; type?: string; zone: string },
): RecordRow[] {
  const name = filter.name !== undefined ? canonicalName(filter.name, filter.zone) : undefined;
  const type = filter.type?.trim().toUpperCase();
  return rows.filter((r) => (name === undefined || r.name === name) && (!type || r.type === type));
}
