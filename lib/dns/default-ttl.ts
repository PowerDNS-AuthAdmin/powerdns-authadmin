/**
 * lib/dns/default-ttl.ts
 *
 * The TTL a new record starts with in the editor. Resolution order, most
 * specific first:
 *
 *   1. the zone's `X-AUTHADMIN-DEFAULT-TTL` metadata (per-zone override)
 *   2. the `default_record_ttl` app setting (global, admin Settings / YAML)
 *   3. 3600
 *
 * The per-zone value lives in PowerDNS domain metadata rather than our own
 * database so it travels with the zone - it's visible to anything else that
 * reads the zone's metadata, survives an AuthAdmin reinstall, and is written
 * through the existing metadata route with its permission check and audit.
 *
 * Pure and dependency-free so server components, route handlers and client
 * components share one parser.
 */

export const BUILTIN_DEFAULT_TTL = 3600;

/** Bounds match the record TTL accepted elsewhere (32-bit signed, RFC 2181 §8). */
export const MIN_DEFAULT_TTL = 1;
export const MAX_DEFAULT_TTL = 2147483647;

/** Custom PowerDNS metadata kind holding a zone's default record TTL. */
export const ZONE_DEFAULT_TTL_KIND = "X-AUTHADMIN-DEFAULT-TTL";

export type DefaultTtlSource = "zone" | "global" | "builtin";

export interface ResolvedDefaultTtl {
  ttl: number;
  source: DefaultTtlSource;
}

/** Parse a stored TTL string; null when it isn't a whole number in range. */
export function parseDefaultTtl(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_DEFAULT_TTL && n <= MAX_DEFAULT_TTL ? n : null;
}

/**
 * The zone's default TTL from its metadata list, or null when unset. A value
 * hand-set to garbage on the PowerDNS host is ignored rather than surfaced as
 * an error - the editor falls back to the global default.
 */
export function zoneDefaultTtlFromMetadata(
  metadata: ReadonlyArray<{ kind: string; metadata: readonly string[] }>,
): number | null {
  const entry = metadata.find((m) => m.kind === ZONE_DEFAULT_TTL_KIND);
  const first = entry?.metadata[0];
  return first === undefined ? null : parseDefaultTtl(first);
}

export function resolveDefaultTtl(input: {
  zone: number | null;
  global: number | null;
}): ResolvedDefaultTtl {
  if (input.zone !== null) return { ttl: input.zone, source: "zone" };
  if (input.global !== null) return { ttl: input.global, source: "global" };
  return { ttl: BUILTIN_DEFAULT_TTL, source: "builtin" };
}

/**
 * Validation error for a write of the per-zone kind, or null when the values
 * are acceptable. Exactly one whole-number value: PowerDNS stores metadata as
 * a string list, so without this a typo would be saved and silently ignored.
 */
export function zoneDefaultTtlValuesError(values: readonly string[]): string | null {
  if (values.length !== 1 || parseDefaultTtl(values[0]!) === null) {
    return `${ZONE_DEFAULT_TTL_KIND} takes a single whole number of seconds between ${MIN_DEFAULT_TTL} and ${MAX_DEFAULT_TTL}.`;
  }
  return null;
}
