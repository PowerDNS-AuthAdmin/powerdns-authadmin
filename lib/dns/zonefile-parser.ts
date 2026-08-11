/**
 * lib/dns/zonefile-parser.ts
 *
 * RFC 1035-style BIND zonefile parser. Pure - given a string of one or
 * more zonefiles, returns a list of zones with their rrsets.
 *
 * Multi-zone parse: a single input may contain several zones separated by
 * `$ORIGIN <fqdn>.` directives. Each $ORIGIN switches the active origin;
 * rrsets accumulate under the most recently declared origin. Empty zones
 * (no rrsets after their $ORIGIN) are emitted as zero-rrset entries.
 *
 * Supported syntax:
 *   - Comments: `;` to end-of-line.
 *   - Directives: `$TTL <seconds>`, `$ORIGIN <fqdn>.`.
 *   - Owner: `@` (= origin), bare label (= label + "." + origin),
 *     fully-qualified name with trailing dot (= as-is).
 *   - Class: optional `IN` (anything else rejected).
 *   - TTL: optional integer (falls back to `$TTL` then a 3600 default).
 *   - Type: any non-pseudo type - A, AAAA, NS, MX, CNAME, SOA, TXT,
 *     SRV, PTR, CAA, NAPTR, SPF, etc. Pseudo-types (RRSIG, NSEC, …)
 *     are skipped silently since DNSSEC records are managed by PDNS
 *     itself, not operator-imported.
 *   - Multi-line: parenthesised continuations (typically SOA).
 *   - TXT: quoted strings with the usual `\"` and `\\` escapes.
 *   - Quoted RDATA is opaque: `;`, `(`, `)` and runs of whitespace inside a
 *     character-string are data, not syntax. This is what keeps PowerDNS LUA
 *     records - whose payload is a quoted Lua expression, so parentheses on
 *     every function call - intact through an import.
 *
 * Out of scope:
 *   - `$INCLUDE` (file-traversal vector; refused).
 *   - `$GENERATE` (rarely used in practice).
 */

export interface ParsedRecord {
  content: string;
}

export interface ParsedRRSet {
  name: string;
  type: string;
  ttl: number;
  records: ParsedRecord[];
}

export interface ParsedZone {
  /** Canonical zone name (lowercase, trailing dot). */
  name: string;
  rrsets: ParsedRRSet[];
}

export interface ParseDiagnostic {
  /** 1-indexed input line number. */
  line: number;
  level: "error" | "warning";
  message: string;
}

export interface ParseResult {
  zones: ParsedZone[];
  diagnostics: ParseDiagnostic[];
}

const DEFAULT_TTL = 3600;

/**
 * Skipped record types - PDNS manages DNSSEC and related signing material
 * via its own `cryptokeys` API; importing them through a zonefile would
 * collide with that. We log a `skipped` warning but don't fail the parse.
 */
const SKIPPED_TYPES = new Set(["RRSIG", "NSEC", "NSEC3", "NSEC3PARAM", "DNSKEY", "CDS", "CDNSKEY"]);

export function parseZonefile(input: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const zonesByOrigin = new Map<string, ParsedZone>();

  let currentOrigin: string | null = null;
  let currentTtl = DEFAULT_TTL;

  // Pre-process: tokenize each physical line into fields, then join
  // parenthesised continuations into single logical lines. We track the
  // SOURCE line of each joined line for diagnostics.
  const physicalLines = input.split(/\r?\n/);
  const logicalLines: Array<{ line: number; fields: string[] }> = [];
  let buffer: string[] = [];
  let bufferStartLine = 0;
  let parenDepth = 0;
  for (let i = 0; i < physicalLines.length; i += 1) {
    const scanned = scanLine(physicalLines[i] ?? "", parenDepth);
    parenDepth = scanned.parenDepth;
    if (scanned.unterminatedQuote) {
      diagnostics.push({
        line: i + 1,
        level: "error",
        message: "Unterminated quoted string (a character-string cannot span lines).",
      });
    }

    if (parenDepth === 0) {
      if (buffer.length > 0) {
        // Append the final piece of a multi-line record.
        buffer.push(...scanned.fields);
        logicalLines.push({ line: bufferStartLine, fields: buffer });
        buffer = [];
      } else if (scanned.fields.length > 0) {
        logicalLines.push({ line: i + 1, fields: scanned.fields });
      }
    } else {
      if (buffer.length === 0) {
        bufferStartLine = i + 1;
        buffer = scanned.fields;
      } else {
        buffer.push(...scanned.fields);
      }
    }
  }
  if (buffer.length > 0) {
    diagnostics.push({
      line: bufferStartLine,
      level: "error",
      message: "Unterminated parenthesised record (no closing ')').",
    });
  }

  for (const { line, fields } of logicalLines) {
    // Only for diagnostics - the parse itself works off `fields`, which
    // preserve whitespace inside quoted strings that this join collapses.
    const text = fields.join(" ");

    // Directives - $-prefixed.
    if (fields[0]!.startsWith("$")) {
      const name = fields[0]!.slice(1).toUpperCase();
      const rest = fields.slice(1).join(" ");
      if (!/^[A-Z0-9_]+$/.test(name) || rest.length === 0) {
        diagnostics.push({ line, level: "error", message: `Malformed directive: ${text}` });
        continue;
      }
      if (name === "TTL") {
        const ttl = Number(rest);
        if (!Number.isFinite(ttl) || ttl < 0) {
          diagnostics.push({ line, level: "error", message: `Invalid $TTL value: ${rest}` });
          continue;
        }
        currentTtl = Math.floor(ttl);
      } else if (name === "ORIGIN") {
        const origin = canonicalize(rest);
        if (!origin) {
          diagnostics.push({ line, level: "error", message: `Invalid $ORIGIN: ${rest}` });
          continue;
        }
        currentOrigin = origin;
        if (!zonesByOrigin.has(origin)) {
          zonesByOrigin.set(origin, { name: origin, rrsets: [] });
        }
      } else if (name === "INCLUDE") {
        diagnostics.push({
          line,
          level: "error",
          message: "$INCLUDE is not supported (file-system access from imports is refused).",
        });
      } else {
        diagnostics.push({ line, level: "warning", message: `Unknown directive: $${name}` });
      }
      continue;
    }

    // Record line: name [ttl] [class] type rdata...
    if (currentOrigin === null) {
      diagnostics.push({
        line,
        level: "error",
        message: "Record before any $ORIGIN - add `$ORIGIN <zone>.` at the top of the file.",
      });
      continue;
    }

    const parts = fields;
    if (parts.length < 3) {
      diagnostics.push({ line, level: "error", message: `Too few fields: ${text}` });
      continue;
    }

    let cursor = 0;
    const owner = parts[cursor++]!;
    let ttl: number | undefined;
    if (/^\d+$/.test(parts[cursor]!)) {
      ttl = Number(parts[cursor++]);
    }
    if (parts[cursor]?.toUpperCase() === "IN") cursor += 1;
    if (!ttl && /^\d+$/.test(parts[cursor]!)) {
      // Class-then-TTL ordering (less common but RFC-permitted).
      ttl = Number(parts[cursor++]);
    }
    const type = parts[cursor++]?.toUpperCase();
    const rdata = parts.slice(cursor).join(" ").trim();
    if (!type || !rdata) {
      diagnostics.push({ line, level: "error", message: `Missing type or rdata: ${text}` });
      continue;
    }

    if (SKIPPED_TYPES.has(type)) {
      diagnostics.push({
        line,
        level: "warning",
        message: `Skipping ${type} record - DNSSEC material is managed by PowerDNS, not imported.`,
      });
      continue;
    }

    const fqdn = expandOwner(owner, currentOrigin);
    const zone = zonesByOrigin.get(currentOrigin)!;
    pushRRSet(zone, fqdn, type, ttl ?? currentTtl, rdata);
  }

  return { zones: [...zonesByOrigin.values()], diagnostics };
}

interface ScannedLine {
  /** Whitespace-separated fields; quoted strings survive verbatim. */
  fields: string[];
  /** Paren depth after this line - non-zero means the record continues. */
  parenDepth: number;
  /** A `"` was left open at end-of-line, which is always malformed. */
  unterminatedQuote: boolean;
}

/**
 * Split one physical line into fields, honouring RFC 1035 quoting.
 *
 * Comment stripping, escape handling, field splitting and paren-depth
 * accounting all need the same quote state, so they share one pass. Modelling
 * that state more than once is what let a `(` inside quoted RDATA be read as a
 * line-continuation marker - it silently rewrote every Lua expression on
 * import, and derailed continuation tracking on quoted TXT.
 *
 * Inside quotes, `;` `(` `)` and whitespace are all just bytes: per RFC 1035
 * §5.1 parens are structural only outside a character-string. Outside quotes,
 * a paren is a continuation marker and separates fields rather than joining
 * them, so `(2026081101` yields the serial without the paren glued on.
 *
 * Quote state deliberately does NOT carry to the next line: a character-string
 * cannot span a newline, so an unbalanced `"` is a broken line rather than an
 * open state the following lines inherit.
 */
function scanLine(line: string, parenDepth: number): ScannedLine {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let escaped = false;

  const flush = (): void => {
    if (field.length > 0) {
      fields.push(field);
      field = "";
    }
  };

  for (const ch of line) {
    if (escaped) {
      // The backslash is kept so the escape survives into the RDATA.
      field += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      field += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      field += ch;
      continue;
    }
    if (inQuotes) {
      field += ch;
      continue;
    }
    if (ch === ";") break; // comment runs to end-of-line
    if (ch === "(") {
      parenDepth += 1;
      flush();
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      flush();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") {
      flush();
      continue;
    }
    field += ch;
  }
  flush();

  return { fields, parenDepth, unterminatedQuote: inQuotes };
}

function canonicalize(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  if (!/^[a-z0-9._-]+\.?$/.test(trimmed)) return null;
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

function expandOwner(owner: string, origin: string): string {
  if (owner === "@") return origin;
  const lower = owner.toLowerCase();
  if (lower.endsWith(".")) return lower;
  return `${lower}.${origin}`;
}

function pushRRSet(
  zone: ParsedZone,
  name: string,
  type: string,
  ttl: number,
  content: string,
): void {
  // Identical (name, type) entries collapse into one rrset with multiple
  // records - PDNS' API expects rrsets at that granularity.
  const existing = zone.rrsets.find((rr) => rr.name === name && rr.type === type);
  if (existing) {
    existing.records.push({ content });
    // TTLs within an rrset must agree per RFC; if they disagree, keep the
    // first one (operators rarely mix on purpose).
    return;
  }
  zone.rrsets.push({ name, type, ttl, records: [{ content }] });
}
