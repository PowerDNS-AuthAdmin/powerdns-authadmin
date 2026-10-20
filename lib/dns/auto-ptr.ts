/**
 * lib/dns/auto-ptr.ts
 *
 * The decision table for automatic PTR maintenance: given one A/AAAA change
 * (what the RRset looked like before, what it will look like after), the
 * reverse zones this installation hosts and the PTR RRsets that already exist
 * at the affected owner names, decide what to do for every address.
 *
 * Rules, in the order they matter:
 *
 *   - An address with no hosted reverse zone is skipped, loudly. The reverse
 *     zone is never created: a PTR nobody delegated to answers no query.
 *   - A PTR is only ever created, re-pointed or deleted when it points at the
 *     forward record's own name. One that points somewhere else is left alone
 *     and reported as a conflict; `takeover` is the explicit opt-in to replace
 *     it. The legacy tool overwrote silently, which is how round-robin and
 *     shared-IP vhosts lost their reverse names.
 *   - Removing an address from the forward RRset (or deleting the RRset)
 *     removes the PTR only while it still points at this name. A PTR that was
 *     re-pointed since is somebody else's.
 *   - The PTR mirrors the forward record's TTL and `disabled` flag, so a
 *     temporarily disabled host keeps its reverse name, also disabled.
 *
 * Pure: the orchestrator in `lib/pdns/auto-ptr.ts` does the reads and writes;
 * this file does the thinking, so the editor's review modal, the API and the
 * tests all agree on the outcome before anything is written.
 */

import { findReverseZone, reverseOwnerName, sameAddress } from "./reverse-name";

export type AddressRecordType = "A" | "AAAA";

export interface AddressRecord {
  content: string;
  disabled?: boolean;
}

/** The forward change, already normalised (owner name canonical, type upper-case). */
export interface AddressChange {
  kind: "upsert" | "delete";
  /** Forward owner name, lowercase with trailing dot. */
  name: string;
  type: AddressRecordType;
  /** New TTL (upsert only). */
  ttl?: number;
  /** New records (upsert only). */
  records?: readonly AddressRecord[];
}

export interface ExistingPtr {
  ttl: number;
  records: readonly AddressRecord[];
}

/** What the planner needs to know about the world. */
export interface PtrPlanContext {
  /** Canonical names of every reverse zone the installation hosts (writable or not). */
  hostedReverseZones: Iterable<string>;
  /** PTR RRsets that exist at the owner names the plan may touch, keyed by owner. */
  existing: ReadonlyMap<string, ExistingPtr>;
  /** Replace PTRs that point at another name. Off unless the operator asked. */
  takeover?: boolean;
}

export type PtrAction = "create" | "update" | "delete" | "unchanged" | "skip" | "conflict";

export type PtrSkipReason = "no-reverse-zone" | "points-elsewhere" | "already-absent";

export interface PtrPlanItem {
  /** The address as written in the forward record. */
  ip: string;
  /** PTR owner name in the global reverse tree (always computable for a valid address). */
  owner: string;
  /** The hosted zone the PTR lives in; null when none covers the address. */
  reverseZone: string | null;
  action: PtrAction;
  reason?: PtrSkipReason;
  /** Targets the existing PTR RRset points at, when it exists. */
  currentTargets?: string[];
  /**
   * The PTR RRset to write (`create` / `update`) - every record, since the
   * write is a REPLACE. Absent for `delete`, `unchanged`, `skip`, `conflict`.
   */
  rrset?: { ttl: number; records: AddressRecord[] };
}

export interface PtrPlan {
  change: Pick<AddressChange, "kind" | "name" | "type">;
  items: PtrPlanItem[];
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function uniqueAddresses(records: readonly AddressRecord[]): AddressRecord[] {
  const out: AddressRecord[] = [];
  for (const r of records) {
    if (!out.some((x) => sameAddress(x.content, r.content))) out.push(r);
  }
  return out;
}

/**
 * Plan the PTR side of one forward change. `before` is the live forward RRset
 * (or null when it did not exist); `change` is what it becomes.
 */
export function planPtrChanges(
  change: AddressChange,
  before: { ttl: number; records: readonly AddressRecord[] } | null,
  ctx: PtrPlanContext,
): PtrPlan {
  const target = change.name.toLowerCase();
  const takeover = ctx.takeover === true;
  const hosted = [...ctx.hostedReverseZones];
  const desired = change.kind === "upsert" ? uniqueAddresses(change.records ?? []) : [];
  const previous = uniqueAddresses(before?.records ?? []);
  const items: PtrPlanItem[] = [];

  for (const rec of desired) {
    const owner = reverseOwnerName(rec.content);
    if (!owner) continue; // not an address; PowerDNS rejects it upstream anyway
    const match = findReverseZone(rec.content, hosted);
    if (!match) {
      items.push({
        ip: rec.content,
        owner,
        reverseZone: null,
        action: "skip",
        reason: "no-reverse-zone",
      });
      continue;
    }
    const want = {
      ttl: change.ttl ?? before?.ttl ?? 0,
      records: [{ content: target, ...(rec.disabled ? { disabled: true } : {}) }],
    };
    const current = ctx.existing.get(match.owner);
    if (!current || current.records.length === 0) {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "create",
        rrset: want,
      });
      continue;
    }
    const targets = current.records.map((r) => r.content);
    const allOurs = current.records.every((r) => sameName(r.content, target));
    if (allOurs) {
      const unchanged =
        current.ttl === want.ttl &&
        current.records.length === 1 &&
        (current.records[0]!.disabled === true) === (rec.disabled === true);
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: unchanged ? "unchanged" : "update",
        currentTargets: targets,
        ...(unchanged ? {} : { rrset: want }),
      });
      continue;
    }
    if (takeover) {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "update",
        currentTargets: targets,
        rrset: want,
      });
    } else {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "conflict",
        currentTargets: targets,
      });
    }
  }

  for (const rec of previous) {
    if (desired.some((d) => sameAddress(d.content, rec.content))) continue;
    const owner = reverseOwnerName(rec.content);
    if (!owner) continue;
    const match = findReverseZone(rec.content, hosted);
    if (!match) {
      items.push({
        ip: rec.content,
        owner,
        reverseZone: null,
        action: "skip",
        reason: "no-reverse-zone",
      });
      continue;
    }
    const current = ctx.existing.get(match.owner);
    if (!current || current.records.length === 0) {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "unchanged",
        reason: "already-absent",
      });
      continue;
    }
    const targets = current.records.map((r) => r.content);
    const ours = current.records.filter((r) => sameName(r.content, target));
    if (ours.length === 0) {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "unchanged",
        reason: "points-elsewhere",
        currentTargets: targets,
      });
      continue;
    }
    if (ours.length === current.records.length) {
      items.push({
        ip: rec.content,
        owner: match.owner,
        reverseZone: match.zone,
        action: "delete",
        currentTargets: targets,
      });
      continue;
    }
    // A multi-target PTR RRset that includes us: drop only our record.
    const remaining = current.records.filter((r) => !sameName(r.content, target));
    items.push({
      ip: rec.content,
      owner: match.owner,
      reverseZone: match.zone,
      action: "update",
      currentTargets: targets,
      rrset: { ttl: current.ttl, records: remaining.map((r) => ({ ...r })) },
    });
  }

  return { change: { kind: change.kind, name: change.name, type: change.type }, items };
}

/** Owner names a plan for `change` could touch, so the orchestrator knows what to fetch. */
export function candidatePtrOwners(
  change: AddressChange,
  before: { records: readonly AddressRecord[] } | null,
  hostedReverseZones: Iterable<string>,
): Map<string, string> {
  const hosted = [...hostedReverseZones];
  const out = new Map<string, string>(); // owner -> zone
  const all = [
    ...(change.kind === "upsert" ? (change.records ?? []) : []),
    ...(before?.records ?? []),
  ];
  for (const rec of all) {
    const match = findReverseZone(rec.content, hosted);
    if (match) out.set(match.owner, match.zone);
  }
  return out;
}

export function isAddressType(type: string): type is AddressRecordType {
  return type === "A" || type === "AAAA";
}

/* ---------------------------------------------------------------- outcomes */

export type PtrOutcomeReason =
  | PtrSkipReason
  | "no-permission"
  | "reverse-zone-not-writable"
  | "read-failed"
  | "write-failed";

/**
 * What happened (or, for a dry run, what would happen) to one address's PTR.
 * Produced by the orchestrator next to the RRset route, rendered by the
 * editor's review modal and toast, returned to API and MCP callers verbatim.
 */
export interface AutoPtrOutcome {
  forward: { name: string; type: AddressRecordType; kind: "upsert" | "delete" };
  ip: string;
  owner: string;
  reverseZone: string | null;
  /** Slug of the backend hosting the reverse zone, when one was chosen. */
  server: string | null;
  action: PtrAction | "failed";
  reason?: PtrOutcomeReason;
  /** Human-readable detail for `failed` outcomes (already redacted). */
  message?: string;
  currentTargets?: string[];
}

/** One line per outcome, for toasts, MCP results and the audit snapshot. */
export function describePtrOutcome(o: AutoPtrOutcome): string {
  const where = o.reverseZone ? ` in ${o.reverseZone}` : "";
  const pointsAt = o.currentTargets?.length ? ` (currently ${o.currentTargets.join(", ")})` : "";
  switch (o.action) {
    case "create":
      return `${o.ip}: PTR → ${o.forward.name} created${where}.`;
    case "update":
      return `${o.ip}: PTR updated${where}${pointsAt}.`;
    case "delete":
      return `${o.ip}: PTR removed${where}.`;
    case "unchanged":
      if (o.reason === "points-elsewhere")
        return `${o.ip}: PTR left alone, it points elsewhere${pointsAt}.`;
      if (o.reason === "already-absent") return `${o.ip}: no PTR to remove${where}.`;
      return `${o.ip}: PTR already correct${where}.`;
    case "conflict":
      return `${o.ip}: PTR not written, it points at ${o.currentTargets?.join(", ") ?? "another name"}. Tick "replace existing PTR" to take it over.`;
    case "skip":
      switch (o.reason) {
        case "no-reverse-zone":
          return `${o.ip}: no hosted reverse zone covers it, PTR skipped.`;
        case "no-permission":
          return `${o.ip}: you can't write records in ${o.reverseZone ?? "the reverse zone"}, PTR skipped.`;
        case "reverse-zone-not-writable":
          return `${o.ip}: ${o.reverseZone ?? "the reverse zone"} is only hosted read-only here, PTR skipped.`;
        default:
          return `${o.ip}: PTR skipped.`;
      }
    case "failed":
      return `${o.ip}: PTR ${o.reason === "read-failed" ? "read" : "write"} failed${where}${o.message ? `: ${o.message}` : "."}`;
  }
}

export interface PtrOutcomeSummary {
  written: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  failed: number;
  /** Short sentence for a toast; empty when nothing was attempted. */
  text: string;
  /** Severity for the toast kind. */
  level: "none" | "ok" | "warn" | "error";
}

export function summarizePtrOutcomes(outcomes: readonly AutoPtrOutcome[]): PtrOutcomeSummary {
  const s = { written: 0, unchanged: 0, skipped: 0, conflicts: 0, failed: 0 };
  for (const o of outcomes) {
    if (o.action === "create" || o.action === "update" || o.action === "delete") s.written++;
    else if (o.action === "unchanged") s.unchanged++;
    else if (o.action === "skip") s.skipped++;
    else if (o.action === "conflict") s.conflicts++;
    else s.failed++;
  }
  const parts: string[] = [];
  if (s.written) parts.push(`${s.written} PTR ${s.written === 1 ? "record" : "records"} updated`);
  if (s.conflicts) parts.push(`${s.conflicts} left pointing elsewhere`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.failed) parts.push(`${s.failed} failed`);
  const level = s.failed ? "error" : s.conflicts || s.skipped ? "warn" : s.written ? "ok" : "none";
  return { ...s, text: parts.length ? `Reverse DNS: ${parts.join(", ")}.` : "", level };
}
