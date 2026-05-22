/**
 * lib/provisioning/zone-generator.ts
 *
 * Pure helper that produces synthetic zone definitions from a generator
 * spec — used by the demo_zones provisioning section. Kept separate from
 * `apply.ts` so unit tests don't pull lib/db at module load.
 *
 * Each zone gets:
 *   * 2 NS records at the apex (ns1.<base_domain>., ns2.<base_domain>.)
 *   * Up to `recordsPerZone` user records (apex A x2, www A, mail A, MX,
 *     SPF TXT, api A, cdn CNAME, then synthetic `hostNN` A records to pad)
 *
 * The PDNS createZone path packs records into rrsets keyed on (name,
 * type) — multiple A records on the same name end up as one rrset with
 * multiple `records` entries.
 */

import "server-only";
import type { RRsetPatch } from "@/lib/pdns/rrsets";

export interface GeneratedZone {
  /** Canonical zone name with trailing dot. */
  name: string;
  /** REPLACE rrsets ready for `client.createZone({ rrsets })`. */
  rrsets: RRsetPatch[];
  /** NS hostnames for the create-zone payload's `nameservers` field
   *  (PDNS auto-creates the apex NS rrset from this). */
  nameservers: string[];
}

export interface GeneratorSpec {
  namePrefix: string;
  baseDomain: string;
  count: number;
  recordsPerZone: number;
  /**
   * NS hostnames written into every generated zone. Defaults to
   * `ns1.<baseDomain>.` and `ns2.<baseDomain>.`. The
   * primary-with-Secondaries topology needs the receiving Secondaries'
   * supermaster nameservers to appear here, otherwise auto-secondary
   * verification on NOTIFY rejects the zone.
   */
  nameservers?: string[];
}

/**
 * Build the full set of demo zones for one provisioning spec. Deterministic
 * (the per-zone records derive from the index), so re-running produces an
 * identical payload and the idempotent upsert at the PDNS layer is a
 * no-op.
 */
export function generateZones(spec: GeneratorSpec): GeneratedZone[] {
  const out: GeneratedZone[] = [];
  const apex = spec.baseDomain.endsWith(".") ? spec.baseDomain : `${spec.baseDomain}.`;
  // Operator-supplied NS list wins; default is the synthetic
  // ns1/ns2.<apex> pair (fine for standalone + cluster topologies where
  // PDNS isn't doing NOTIFY-based verification against the NS list).
  const nameservers =
    spec.nameservers && spec.nameservers.length > 0
      ? spec.nameservers.map(ensureTrailingDot)
      : [`ns1.${apex}`, `ns2.${apex}`];

  for (let i = 1; i <= spec.count; i += 1) {
    const zoneName = `${spec.namePrefix}-${i}.${apex}`;
    const rrsets = buildZoneRrsets({
      zoneName,
      index: i,
      apex,
      recordsPerZone: spec.recordsPerZone,
    });
    out.push({ name: zoneName, rrsets, nameservers });
  }
  return out;
}

function ensureTrailingDot(host: string): string {
  return host.endsWith(".") ? host : `${host}.`;
}

interface BuildArgs {
  zoneName: string;
  index: number;
  apex: string;
  recordsPerZone: number;
}

function buildZoneRrsets(args: BuildArgs): RRsetPatch[] {
  const { zoneName, index, recordsPerZone } = args;
  // Stage a flat list of (name, type, content) tuples; group by (name, type)
  // into rrsets at the end.
  const flat: Array<{ name: string; type: string; ttl: number; content: string }> = [];

  // The "default 10 records" template, in priority order — the slice below
  // trims to `recordsPerZone`. Realistic enough to look like an in-use zone.
  const template: Array<{ name: string; type: string; ttl: number; content: string }> = [
    { name: zoneName, type: "A", ttl: 3600, content: `10.0.${index}.1` },
    { name: zoneName, type: "A", ttl: 3600, content: `10.0.${index}.2` },
    { name: `www.${zoneName}`, type: "A", ttl: 3600, content: `10.0.${index}.10` },
    { name: `mail.${zoneName}`, type: "A", ttl: 3600, content: `10.0.${index}.20` },
    { name: zoneName, type: "MX", ttl: 3600, content: `10 mail.${zoneName}` },
    { name: zoneName, type: "TXT", ttl: 3600, content: `"v=spf1 mx -all"` },
    { name: `api.${zoneName}`, type: "A", ttl: 300, content: `10.0.${index}.30` },
    { name: `cdn.${zoneName}`, type: "CNAME", ttl: 3600, content: `cdn.example.net.` },
    { name: `host01.${zoneName}`, type: "A", ttl: 3600, content: `10.0.${index}.101` },
    { name: `host02.${zoneName}`, type: "A", ttl: 3600, content: `10.0.${index}.102` },
  ];

  for (const r of template) flat.push(r);
  // If the caller asked for more than the template provides, pad with
  // synthetic host records (host03, host04, …) starting at .103.
  for (let j = template.length; j < recordsPerZone; j += 1) {
    const n = j - template.length + 3;
    flat.push({
      name: `host${String(n).padStart(2, "0")}.${zoneName}`,
      type: "A",
      ttl: 3600,
      content: `10.0.${index}.${100 + n}`,
    });
  }
  // If they asked for fewer, trim from the end.
  if (flat.length > recordsPerZone) flat.length = recordsPerZone;

  // Group by (name, type) → REPLACE rrsets.
  const byKey = new Map<string, RRsetPatch>();
  for (const r of flat) {
    const key = `${r.name}|${r.type}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.records!.push({ content: r.content });
    } else {
      byKey.set(key, {
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        changetype: "REPLACE",
        records: [{ content: r.content }],
        comments: [],
      });
    }
  }
  return Array.from(byKey.values());
}
