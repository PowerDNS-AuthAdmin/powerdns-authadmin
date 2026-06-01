/**
 * lib/dns/zonefile-formatter.ts
 *
 * Render a PDNS zone detail (zone metadata + rrsets) as a BIND-format
 * zonefile. Output is the inverse of `parseZonefile()`: feeding the
 * output of `formatZonefile()` back into the parser must round-trip
 * (records-wise; comments + arbitrary whitespace are normalized).
 *
 * One file may carry one or many zones; the bulk-export endpoint
 * concatenates per-zone outputs.
 */

import type { PdnsZoneDetail } from "@/lib/pdns/types";

interface FormatOptions {
  /** Inject a `; comment line` at the top - useful for "exported by
   * {app} at {timestamp}" headers in bundles. Each entry becomes its
   * own `; …` line. */
  header?: string[];
}

export function formatZonefile(zone: PdnsZoneDetail, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  for (const h of opts.header ?? []) {
    lines.push(`; ${h}`);
  }
  lines.push(`$ORIGIN ${zone.name}`);
  if (zone.rrsets && zone.rrsets.length > 0) {
    // Stable rrset ordering: SOA first, then NS at apex, then alphabetic by
    // (name, type) - matches what most operators expect from `dig AXFR`.
    const sorted = [...zone.rrsets].sort((a, b) => {
      const aw = weight(a.name, a.type, zone.name);
      const bw = weight(b.name, b.type, zone.name);
      if (aw !== bw) return aw - bw;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.type.localeCompare(b.type);
    });
    for (const rr of sorted) {
      for (const record of rr.records) {
        if (record.disabled) {
          lines.push(`; disabled: ${rr.name} ${rr.ttl} IN ${rr.type} ${record.content}`);
          continue;
        }
        lines.push(`${rr.name} ${rr.ttl} IN ${rr.type} ${record.content}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function weight(name: string, type: string, origin: string): number {
  const atApex = name === origin;
  if (atApex && type === "SOA") return 0;
  if (atApex && type === "NS") return 1;
  if (atApex) return 2;
  return 3;
}
