/**
 * lib/validators/soa.ts
 *
 * Parse + serialize SOA RDATA. SOA is the zone's start-of-authority record
 * and its RDATA encodes the zone's primary nameserver, the responsible-
 * party mailbox, the serial, and four timers.
 *
 * Presentation form (RFC 1035 § 5):
 *   <mname> <rname> <serial> <refresh> <retry> <expire> <minimum>
 *
 *   mname   primary master name server, fully qualified
 *   rname   responsible-party mailbox, encoded as a hostname (the local
 *           part's "@" is replaced with a "."; literal dots in the local
 *           part are escaped with `\`).
 *   serial  32-bit unsigned, monotonically increasing per RFC 1982 (PDNS
 *           manages this for us — we present it read-only).
 *   refresh how often a secondary checks the primary for changes (sec)
 *   retry   how long a secondary waits before retrying a failed refresh
 *   expire  how long a secondary serves the zone while unreachable
 *   minimum negative-cache TTL (RFC 2308)
 *
 * The operator edits everything *except* serial through the SOA panel.
 * PowerDNS advances the serial automatically on any zone PATCH.
 *
 * No "server-only" marker: these are pure functions over strings (no DB,
 * no env, no secrets) and the SoaPanel client component imports them
 * directly to parse the current SOA, build the new content, and render
 * sanity warnings inline. Server callers (the zone change-log) reuse the
 * same pure code path.
 */

export interface SoaFields {
  /** Primary master name server (mname). Fully qualified. */
  mname: string;
  /** Responsible-party mailbox (rname). Fully qualified, "@" → ".". */
  rname: string;
  /** Serial number. Read-only from the operator's perspective. */
  serial: number;
  /** Refresh interval, seconds (RFC 1035 § 3.3.13). */
  refresh: number;
  /** Retry interval, seconds. */
  retry: number;
  /** Expire interval, seconds. */
  expire: number;
  /** Negative-cache TTL, seconds (RFC 2308). */
  minimum: number;
}

/**
 * Parse a SOA RDATA string. PowerDNS hands us the canonical form (single
 * spaces, no comments) so we keep the parser simple. Throws on malformed
 * input — callers fall back to defaults in that case.
 */
export function parseSoaContent(content: string): SoaFields {
  const parts = content.trim().split(/\s+/);
  if (parts.length !== 7) {
    throw new Error(
      `SOA content has ${parts.length} fields; expected 7 (mname rname serial refresh retry expire minimum).`,
    );
  }
  const [mname, rname, serial, refresh, retry, expire, minimum] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const ints = [serial, refresh, retry, expire, minimum].map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`SOA timer "${s}" is not a non-negative integer.`);
    }
    return n;
  });
  return {
    mname,
    rname,
    serial: ints[0]!,
    refresh: ints[1]!,
    retry: ints[2]!,
    expire: ints[3]!,
    minimum: ints[4]!,
  };
}

/**
 * Build SOA RDATA from a struct. Output uses single-space separators —
 * matches PDNS's canonical form so the diff between current and new is
 * minimal (no whitespace noise).
 */
export function serializeSoaContent(fields: SoaFields): string {
  return [
    fields.mname,
    fields.rname,
    String(fields.serial),
    String(fields.refresh),
    String(fields.retry),
    String(fields.expire),
    String(fields.minimum),
  ].join(" ");
}

/**
 * Default SOA when a zone doesn't have one yet. Values are commonly-used
 * conservative defaults — operators tune them as needed.
 *   refresh   1h   — frequent enough for active zones
 *   retry    15m   — quick recovery without hammering
 *   expire    7d   — secondaries stop serving after a week of unreach
 *   minimum   1h   — negative-cache for an hour
 */
export const SOA_DEFAULTS = {
  refresh: 3600,
  retry: 900,
  expire: 604800,
  minimum: 3600,
} as const;

/**
 * Sanity-check ranges + relationships. Returns a list of warnings; doesn't
 * throw. The SOA panel surfaces these alongside the form.
 *
 * Guidance from RFC 1912 § 2.2:
 *   - retry < refresh
 *   - expire >> refresh + retry (operator-discretion factor)
 *   - minimum 1h–1d is reasonable
 *   - refresh ≥ 1200 (20 min) for typical zones to avoid hammering the primary
 */
export function soaSanityWarnings(fields: SoaFields): string[] {
  const warnings: string[] = [];
  if (fields.retry >= fields.refresh) {
    warnings.push(
      "Retry should be less than refresh — otherwise secondaries hammer the primary after a failure (RFC 1912 § 2.2).",
    );
  }
  if (fields.expire <= fields.refresh + fields.retry) {
    warnings.push(
      "Expire is unusually low relative to refresh + retry. Secondaries may stop serving the zone too aggressively when the primary blips.",
    );
  }
  if (fields.refresh < 1200) {
    warnings.push(
      "Refresh below 20 min — primaries can get hammered. RFC 1912 § 2.2 suggests ≥ 1200 for most zones.",
    );
  }
  if (fields.minimum < 60) {
    warnings.push(
      "Minimum (negative-cache TTL) below 60s — most resolvers ignore this floor anyway (RFC 2308 § 5).",
    );
  }
  if (fields.minimum > 86400) {
    warnings.push(
      "Minimum above 24 h — negative answers will be cached for a long time; fixing typos becomes slow to propagate.",
    );
  }
  return warnings;
}
