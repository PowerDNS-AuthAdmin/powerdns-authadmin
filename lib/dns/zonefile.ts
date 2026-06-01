/**
 * lib/dns/zonefile.ts
 *
 * RFC 1035-style BIND zonefile serializer. Pure - given a list of
 * rrsets, returns a string that BIND, NSD, and PowerDNS (`pdnsutil
 * load-zone`) all accept.
 *
 * Issue #9: export side. The parser (import side) ships later;
 * exporting first because it's read-only - operators get
 * "download zonefile" for DR / migration / external review with no
 * risk of a half-baked parser corrupting a zone on import.
 *
 * Output format follows RFC 1035 § 5 + the de-facto BIND extensions:
 *   - `$TTL <seconds>` directive at the top (the zone's default).
 *   - `$ORIGIN <zone-name>.` directive - sets owner expansion.
 *   - One rrset per text block, columns left-aligned for readability.
 *   - SOA serialised as a multi-line parenthesised expression (also
 *     RFC 1035 § 5; every tool accepts it).
 *   - TXT values wrapped in `"` and escaped per RFC 1035 § 5.1.
 *
 * Owner names are relativised to the origin: `www.example.com.`
 * becomes `www` when the origin is `example.com.`. The zone apex is
 * `@`. This is BIND's idiomatic form - `pdnsutil load-zone` and `nsd`
 * both parse it without complaint.
 */

export interface ZonefileRecord {
  content: string;
  disabled?: boolean;
}

export interface ZonefileRRSet {
  /** Fully-qualified owner name with trailing dot. */
  name: string;
  type: string;
  ttl: number;
  records: ZonefileRecord[];
}

interface SerializeInput {
  /** Canonical zone name (lowercase, trailing dot - `example.com.`). */
  zoneName: string;
  rrsets: readonly ZonefileRRSet[];
  /** Default TTL for the `$TTL` directive. */
  defaultTtl?: number;
  /** Header comments printed before the directives (one line each). */
  headerComments?: readonly string[];
}

/**
 * Render the rrsets to a single BIND zonefile string. SOA always
 * emits first (RFC 1035 § 2 requires it at the apex); NS records
 * follow; everything else in (owner, type)-sorted order.
 */
export function serializeZonefile(input: SerializeInput): string {
  const origin = ensureTrailingDot(input.zoneName);
  const defaultTtl = pickDefaultTtl(input.rrsets, input.defaultTtl);
  const lines: string[] = [];

  for (const c of input.headerComments ?? []) {
    // Comment lines per RFC 1035 § 5.1 - split if the operator passed
    // a multi-line block.
    for (const sub of c.split(/\r?\n/)) lines.push(`; ${sub}`);
  }
  lines.push(`$TTL ${defaultTtl}`);
  lines.push(`$ORIGIN ${origin}`);
  lines.push("");

  const sorted = sortRrsets(input.rrsets);
  for (const rr of sorted) {
    lines.push(...serializeRRSet(rr, origin, defaultTtl));
  }

  // Trailing newline keeps `wc -l` and `cat` happy.
  return lines.join("\n") + "\n";
}

function sortRrsets(rrsets: readonly ZonefileRRSet[]): ZonefileRRSet[] {
  const apexSoa = rrsets.filter((r) => r.type === "SOA");
  const apexNs = rrsets.filter((r) => r.type === "NS");
  const others = rrsets
    .filter((r) => r.type !== "SOA" && r.type !== "NS")
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.type.localeCompare(b.type);
    });
  return [...apexSoa, ...apexNs.sort((a, b) => a.name.localeCompare(b.name)), ...others];
}

function serializeRRSet(rr: ZonefileRRSet, origin: string, defaultTtl: number): string[] {
  const owner = relativise(rr.name, origin);
  const ttl = rr.ttl === defaultTtl ? "" : String(rr.ttl);
  // Column widths picked to look right in a typical 80-col terminal;
  // these aren't load-bearing - every parser tokenises on whitespace.
  const ownerCol = owner.padEnd(20, " ");
  const ttlCol = ttl.padEnd(8, " ");
  const typeCol = rr.type.padEnd(8, " ");

  const out: string[] = [];
  for (const record of rr.records) {
    const prefix = record.disabled ? "; (disabled) " : "";
    const rdata = formatRdata(rr.type, record.content);
    if (rr.type === "SOA" && rdata.includes("\n")) {
      // Multi-line parenthesised SOA - emit the first line with the
      // standard prefix, then continuation lines indented.
      const [first, ...rest] = rdata.split("\n");
      out.push(`${prefix}${ownerCol}${ttlCol}IN      ${typeCol}${first}`);
      for (const l of rest) out.push(`${prefix}                            ${l}`);
    } else {
      out.push(`${prefix}${ownerCol}${ttlCol}IN      ${typeCol}${rdata}`);
    }
  }
  return out;
}

/**
 * Relativise an FQDN owner against the zone origin. Apex → "@";
 * `www.example.com.` with origin `example.com.` → `www`; an owner
 * outside the origin keeps its trailing dot (BIND interprets a
 * dot-terminated owner as absolute regardless of $ORIGIN).
 */
function relativise(owner: string, origin: string): string {
  if (owner === origin) return "@";
  if (owner.endsWith(`.${origin}`)) {
    return owner.slice(0, -origin.length - 1);
  }
  return ensureTrailingDot(owner);
}

function ensureTrailingDot(s: string): string {
  return s.endsWith(".") ? s : `${s}.`;
}

function pickDefaultTtl(rrsets: readonly ZonefileRRSet[], override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  if (rrsets.length === 0) return 3600;
  // Mode of the ttl values, falling back to the first rrset's TTL.
  const counts = new Map<number, number>();
  for (const rr of rrsets) counts.set(rr.ttl, (counts.get(rr.ttl) ?? 0) + 1);
  let best = rrsets[0]!.ttl;
  let bestCount = 0;
  for (const [ttl, count] of counts) {
    if (count > bestCount) {
      best = ttl;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Per-type rdata formatting. PowerDNS stores most rdata in BIND
 * presentation form already, so for most types we pass through. SOA
 * is the one that benefits from being expanded to a multi-line
 * parenthesised block so the named-tuple is operator-readable.
 */
function formatRdata(type: string, content: string): string {
  if (type === "SOA") return formatSoa(content);
  if (type === "TXT") return formatTxt(content);
  return content;
}

/**
 * Expand the inline SOA tuple `primary admin serial refresh retry
 * expire minimum` into the multi-line parenthesised form.
 *
 *   ns1.example.com. hostmaster.example.com. (
 *       2026052801 ; serial
 *       3600       ; refresh
 *       600        ; retry
 *       604800     ; expire
 *       3600       ; minimum
 *   )
 *
 * Returns the inline form if the content isn't a 7-field tuple
 * - defensive against unusual SOA strings that might come through.
 */
function formatSoa(content: string): string {
  const parts = content.trim().split(/\s+/);
  if (parts.length !== 7) return content;
  const [primary, admin, serial, refresh, retry, expire, minimum] = parts;
  return (
    `${primary} ${admin} (\n` +
    `    ${(serial ?? "").padEnd(11)} ; serial\n` +
    `    ${(refresh ?? "").padEnd(11)} ; refresh\n` +
    `    ${(retry ?? "").padEnd(11)} ; retry\n` +
    `    ${(expire ?? "").padEnd(11)} ; expire\n` +
    `    ${(minimum ?? "").padEnd(11)} ; minimum\n` +
    `)`
  );
}

/**
 * TXT records: PowerDNS stores them with the quotes already included.
 * If the operator's value happens to be unquoted (legacy / direct API
 * edits), wrap it. Otherwise pass through verbatim.
 */
function formatTxt(content: string): string {
  if (content.startsWith('"') && content.endsWith('"')) return content;
  // Escape embedded quotes + backslashes per RFC 1035 § 5.1.
  const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
