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
 *   - Directives: `$TTL <ttl>`, `$ORIGIN <fqdn>.`.
 *   - Owner: `@` (= origin), bare label (= label + "." + origin),
 *     fully-qualified name with trailing dot (= as-is), or BLANK - a line
 *     that starts with whitespace and whose first field is a TTL, class or
 *     record type reuses the previous record's owner (RFC 1035 §5.1; the
 *     form `named-compilezone` and most hand-written zones use for repeated
 *     names).
 *   - Class: optional `IN` (anything else rejected).
 *   - TTL: optional, as seconds or BIND's unit form (`1h`, `2d`, `1h30m`);
 *     falls back to `$TTL` then a 3600 default.
 *   - Type token must look like an RR type (`A`, `CAA`, `NSEC3PARAM`,
 *     `TYPE65534`); anything else is a diagnostic, never a record.
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

/** RFC 1035 class mnemonics (only IN is accepted downstream, but all are "class-like"). */
const CLASS_TOKENS = new Set(["IN", "CH", "HS", "CS"]);

/**
 * Shape of an RR type mnemonic: letters/digits/hyphen starting with a letter
 * (`A`, `AAAA`, `NSEC3PARAM`, `EUI-48`), or RFC 3597's `TYPE<n>`. A token that
 * fails this where a type is expected is a malformed line, not a record.
 */
const TYPE_TOKEN = /^(?:[A-Z][A-Z0-9-]*|TYPE\d+)$/;

/**
 * RR types used to recognise a blank-owner line (one that starts with
 * whitespace and whose first field is a TTL, class or type). Only the
 * disambiguation needs this list - an indented line whose first field is NOT
 * a known type (`  www IN A …`) is read as an explicit owner, which is more
 * lenient than BIND but matches what the author meant. The type validation
 * itself uses {@link TYPE_TOKEN}, so a type missing here still parses when
 * the owner is explicit.
 */
const KNOWN_RR_TYPES = new Set([
  "A",
  "AAAA",
  "AFSDB",
  "ALIAS",
  "APL",
  "CAA",
  "CDNSKEY",
  "CDS",
  "CERT",
  "CNAME",
  "CSYNC",
  "DHCID",
  "DLV",
  "DNAME",
  "DNSKEY",
  "DS",
  "EUI48",
  "EUI64",
  "HINFO",
  "HTTPS",
  "IPSECKEY",
  "KEY",
  "KX",
  "L32",
  "L64",
  "LOC",
  "LP",
  "LUA",
  "MB",
  "MG",
  "MINFO",
  "MR",
  "MX",
  "NAPTR",
  "NID",
  "NS",
  "NSEC",
  "NSEC3",
  "NSEC3PARAM",
  "OPENPGPKEY",
  "PTR",
  "RKEY",
  "RP",
  "RRSIG",
  "SIG",
  "SMIMEA",
  "SOA",
  "SPF",
  "SRV",
  "SSHFP",
  "SVCB",
  "TKEY",
  "TLSA",
  "TSIG",
  "TXT",
  "URI",
  "WKS",
  "ZONEMD",
]);

const TTL_UNIT_SECONDS: Record<string, number> = {
  S: 1,
  M: 60,
  H: 3600,
  D: 86_400,
  W: 604_800,
};

/**
 * Parse a TTL in seconds or BIND's unit notation (`1h`, `2d`, `1h30m`,
 * case-insensitive). Returns null for anything else, including negative or
 * fractional values and a bare unit.
 */
export function parseTtl(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  if (!/^(?:\d+[smhdw])+$/i.test(token)) return null;
  let total = 0;
  for (const match of token.matchAll(/(\d+)([smhdw])/gi)) {
    total += Number(match[1]) * (TTL_UNIT_SECONDS[match[2]!.toUpperCase()] ?? 0);
  }
  return total;
}

function isTtlToken(token: string): boolean {
  return parseTtl(token) !== null;
}

function isClassToken(token: string): boolean {
  return CLASS_TOKENS.has(token.toUpperCase());
}

function isKnownTypeToken(token: string): boolean {
  const upper = token.toUpperCase();
  return KNOWN_RR_TYPES.has(upper) || /^TYPE\d+$/.test(upper);
}

export function parseZonefile(input: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const zonesByOrigin = new Map<string, ParsedZone>();

  let currentOrigin: string | null = null;
  let currentTtl = DEFAULT_TTL;
  // Owner of the previous record, for blank-owner continuation lines. Reset
  // on every $ORIGIN so a name can never leak from one zone into another.
  let lastOwner: string | null = null;

  // Pre-process: tokenize each physical line into fields, then join
  // parenthesised continuations into single logical lines. We track the
  // SOURCE line of each joined line for diagnostics, and whether its first
  // physical line started with whitespace (the blank-owner signal).
  const physicalLines = input.split(/\r?\n/);
  const logicalLines: Array<{ line: number; fields: string[]; leadingWhitespace: boolean }> = [];
  let buffer: string[] = [];
  let bufferStartLine = 0;
  let bufferLeadingWhitespace = false;
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
        logicalLines.push({
          line: bufferStartLine,
          fields: buffer,
          leadingWhitespace: bufferLeadingWhitespace,
        });
        buffer = [];
      } else if (scanned.fields.length > 0) {
        logicalLines.push({
          line: i + 1,
          fields: scanned.fields,
          leadingWhitespace: scanned.leadingWhitespace,
        });
      }
    } else {
      if (buffer.length === 0) {
        bufferStartLine = i + 1;
        bufferLeadingWhitespace = scanned.leadingWhitespace;
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

  for (const { line, fields, leadingWhitespace } of logicalLines) {
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
        const ttl = parseTtl(rest);
        if (ttl === null) {
          diagnostics.push({ line, level: "error", message: `Invalid $TTL value: ${rest}` });
          continue;
        }
        currentTtl = ttl;
      } else if (name === "ORIGIN") {
        const origin = canonicalize(rest);
        if (!origin) {
          diagnostics.push({ line, level: "error", message: `Invalid $ORIGIN: ${rest}` });
          continue;
        }
        currentOrigin = origin;
        lastOwner = null;
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
    let cursor = 0;

    // Blank owner (RFC 1035 §5.1): the line starts with whitespace and its
    // first field is already the TTL, class or type - reuse the last owner.
    // Without this, `    300 IN A 192.0.2.5` imported as `300.<origin>` and
    // `\t\tIN A 192.0.2.6` as `in.<origin>`, both accepted by PowerDNS.
    let owner: string;
    const first = parts[0]!;
    if (
      leadingWhitespace &&
      (isTtlToken(first) || isClassToken(first) || isKnownTypeToken(first))
    ) {
      if (lastOwner === null) {
        diagnostics.push({
          line,
          level: "error",
          message: `Record has a blank owner but no previous record to inherit it from: ${text}`,
        });
        continue;
      }
      owner = lastOwner;
    } else {
      owner = parts[cursor++]!;
    }

    let ttl: number | undefined;
    const ttlFirst = parts[cursor] !== undefined ? parseTtl(parts[cursor]!) : null;
    if (ttlFirst !== null) {
      ttl = ttlFirst;
      cursor += 1;
    }
    if (parts[cursor] !== undefined && isClassToken(parts[cursor]!)) {
      if (parts[cursor]!.toUpperCase() !== "IN") {
        diagnostics.push({
          line,
          level: "error",
          message: `Unsupported class ${parts[cursor]!.toUpperCase()} (only IN): ${text}`,
        });
        continue;
      }
      cursor += 1;
    }
    if (ttl === undefined && parts[cursor] !== undefined) {
      // Class-then-TTL ordering (less common but RFC-permitted).
      const ttlAfterClass = parseTtl(parts[cursor]!);
      if (ttlAfterClass !== null) {
        ttl = ttlAfterClass;
        cursor += 1;
      }
    }
    const typeToken = parts[cursor++];
    const type = typeToken?.toUpperCase();
    const rdata = parts.slice(cursor).join(" ").trim();
    if (!type || !rdata) {
      diagnostics.push({ line, level: "error", message: `Missing type or rdata: ${text}` });
      continue;
    }
    if (!TYPE_TOKEN.test(type)) {
      diagnostics.push({
        line,
        level: "error",
        message: `Expected a record type, got '${typeToken}': ${text}`,
      });
      continue;
    }

    const fqdn = expandOwner(owner, currentOrigin);
    lastOwner = fqdn;

    if (SKIPPED_TYPES.has(type)) {
      diagnostics.push({
        line,
        level: "warning",
        message: `Skipping ${type} record - DNSSEC material is managed by PowerDNS, not imported.`,
      });
      continue;
    }

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
  /** The line began with whitespace - the blank-owner signal of RFC 1035 §5.1. */
  leadingWhitespace: boolean;
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

  return {
    fields,
    parenDepth,
    unterminatedQuote: inQuotes,
    leadingWhitespace: /^[ \t\f\v]/.test(line),
  };
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
