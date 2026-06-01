/**
 * lib/pdns/rrsets.ts
 *
 * Patch builders + types for the PowerDNS RRset PATCH endpoint.
 * record editing consumes these; this file ships the protocol shapes and
 * a small builder layer so the editor doesn't compose PDNS payloads by hand.
 *
 * PDNS changetypes:
 *   - REPLACE  - write the given records as the new RRset (loses concurrent edits)
 *   - DELETE   - drop the RRset
 *   - EXTEND   - add records to the RRset without touching others (PDNS ≥ 4.9.12 / 5.0.2)
 *   - PRUNE    - remove specific records from the RRset (PDNS ≥ 4.9.12 / 5.0.2)
 *
 * Why this matters: older systems always sent REPLACE. Two operators editing
 * different records of the same RRset would race - last write wins, the loser
 * silently lost their edit. EXTEND/PRUNE close that hole.
 * and the upstream issue history linked there.
 */

import "server-only";

/** PDNS RRset changetype vocabulary. */
export type RRsetChangetype = "REPLACE" | "DELETE" | "EXTEND" | "PRUNE";

/** A single record inside an RRset, as PDNS represents them. */
export interface RRRecord {
  /** Wire-format content, e.g. "1.2.3.4" for A or "10 mail.example.com." for MX. */
  content: string;
  /** When true, PDNS keeps the record but doesn't serve it. Soft-delete. */
  disabled?: boolean;
}

/**
 * A free-form comment carried by an RRset. PDNS' wire shape is
 * `{ content, account, modified_at }` (snake_case), but we accept
 * arbitrary objects here - the editor doesn't author comments yet,
 * and the round-trip path just preserves whatever PDNS returned.
 */
export type RRsetComment = Record<string, unknown>;

/**
 * One PATCH operation. The shape matches the PDNS wire format directly so the
 * builder can JSON-serialize without further translation. `comments` is
 * optional - PDNS keeps existing comments when the field is absent.
 */
export interface RRsetPatch {
  /** Canonical name, trailing dot. The builder enforces this. */
  name: string;
  /** Uppercase RR type. */
  type: string;
  /** Required for REPLACE / EXTEND / PRUNE; ignored on DELETE. */
  ttl?: number;
  changetype: RRsetChangetype;
  records?: RRRecord[];
  comments?: RRsetComment[];
}

export interface ZoneRRsetPatchBody {
  rrsets: RRsetPatch[];
}

// =============================================================================
// Builders
// =============================================================================

interface BuildReplaceArgs {
  name: string;
  type: string;
  ttl: number;
  records: RRRecord[];
  comments?: RRsetComment[];
}

/**
 * REPLACE the whole RRset with `records`. Always supported.
 *
 * `comments` is ALWAYS emitted - PDNS interprets a missing `comments`
 * field as "keep existing comments", while an empty array means "clear
 * them." Callers preserve the live comments by passing them through;
 * sending an explicit empty list when truly absent keeps the audit
 * snapshot symmetrical (the field is always present on both sides of
 * the diff).
 */
export function replaceRRset(args: BuildReplaceArgs): RRsetPatch {
  if (args.records.length === 0) {
    throw new Error("replaceRRset requires at least one record. Use deleteRRset instead.");
  }
  return {
    name: ensureTrailingDot(args.name),
    type: args.type.toUpperCase(),
    ttl: args.ttl,
    changetype: "REPLACE",
    records: args.records,
    comments: args.comments ?? [],
  };
}

/** DELETE the RRset entirely. */
export function deleteRRset(name: string, type: string): RRsetPatch {
  return {
    name: ensureTrailingDot(name),
    type: type.toUpperCase(),
    changetype: "DELETE",
  };
}

interface BuildExtendArgs {
  name: string;
  type: string;
  ttl: number;
  records: RRRecord[];
}

/**
 * EXTEND - add records to an RRset without disturbing existing records.
 * Caller is responsible for checking `client.supports("supportsExtendPrune")`
 * before calling; otherwise PDNS will 400.
 */
export function extendRRset(args: BuildExtendArgs): RRsetPatch {
  if (args.records.length === 0) {
    throw new Error("extendRRset requires at least one record.");
  }
  return {
    name: ensureTrailingDot(args.name),
    type: args.type.toUpperCase(),
    ttl: args.ttl,
    changetype: "EXTEND",
    records: args.records,
  };
}

interface BuildPruneArgs {
  name: string;
  type: string;
  ttl: number;
  records: RRRecord[];
}

/**
 * PRUNE - remove specific records from an RRset without touching others.
 * Same capability gate as `extendRRset`.
 */
export function pruneRRset(args: BuildPruneArgs): RRsetPatch {
  if (args.records.length === 0) {
    throw new Error("pruneRRset requires at least one record to remove.");
  }
  return {
    name: ensureTrailingDot(args.name),
    type: args.type.toUpperCase(),
    changetype: "PRUNE",
    ttl: args.ttl,
    records: args.records,
  };
}

/** Pack one or more RRset patches into the body PDNS expects. */
export function zonePatchBody(...patches: RRsetPatch[]): ZoneRRsetPatchBody {
  if (patches.length === 0) {
    throw new Error("zonePatchBody requires at least one RRset patch.");
  }
  return { rrsets: patches };
}

function ensureTrailingDot(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("RRset name cannot be empty.");
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
