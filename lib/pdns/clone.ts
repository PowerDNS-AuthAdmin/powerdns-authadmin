/**
 * lib/pdns/clone.ts
 *
 * Pure helper for cloning a PDNS zone: rewrites each rrset's `name`
 * to substitute the source zone's apex with a target zone's apex.
 * Strips the SOA rrset (PDNS regenerates one on zone create with
 * sensible defaults - keeping the source's SOA would leak its serial
 * and timers, which is rarely what an operator wants from a clone).
 *
 * Lives in its own module so the rewrite logic can be unit-tested
 * without standing up the HTTP client, audit, or routing layers.
 *
 * Input/output shape mirrors `rrsets[number]` from
 * `pdnsZoneDetailSchema` (in `types.ts`) - kept as a local interface
 * rather than imported so this module stays pure of Zod runtime.
 */

export interface CloneRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}

/**
 * Rewrite an array of rrsets to belong to `targetZone` instead of
 * `sourceZone`. Both zone names must be canonical (lowercase + trailing
 * dot) - call `normalizeZoneId` first. Returns a fresh array; does not
 * mutate the input.
 *
 * SOA rrsets are dropped so PDNS regenerates them on the target.
 *
 * Behavior table for each rrset's `name`:
 *   - Exactly equals `sourceZone` → rewritten to `targetZone` (apex)
 *   - Ends with `.<sourceZone>` (so `www.example.com.` when source is
 *     `example.com.`) → suffix replaced with `targetZone`
 *   - Anything else → preserved verbatim. Cross-zone names shouldn't
 *     appear in a single zone's rrsets per the DNS spec, but if PDNS
 *     ever surfaces one (e.g., a glue record), we leave it alone
 *     rather than silently mangle it. The caller can sanity-check.
 */
export function rewriteRRsetsForClone(
  rrsets: readonly CloneRRset[],
  sourceZone: string,
  targetZone: string,
): CloneRRset[] {
  if (!sourceZone.endsWith(".") || !targetZone.endsWith(".")) {
    throw new Error("rewriteRRsetsForClone: zone names must end with a trailing dot.");
  }
  const out: CloneRRset[] = [];
  for (const r of rrsets) {
    if (r.type === "SOA") continue;
    out.push({
      name: rewriteName(r.name, sourceZone, targetZone),
      type: r.type,
      ttl: r.ttl,
      records: r.records.map((rec) => ({ ...rec })),
    });
  }
  return out;
}

export function rewriteName(name: string, sourceZone: string, targetZone: string): string {
  if (name === sourceZone) return targetZone;
  // The suffix match is `.<sourceZone>` so that a sibling zone with a
  // shared suffix (e.g. `evil-example.com.` when source is
  // `example.com.`) is not accidentally rewritten.
  const suffix = `.${sourceZone}`;
  if (name.endsWith(suffix)) {
    return `${name.slice(0, -sourceZone.length)}${targetZone}`;
  }
  return name;
}
