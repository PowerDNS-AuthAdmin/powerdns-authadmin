/**
 * components/domain/ptr-row-groups.ts
 *
 * Folds Reverse DNS reconciler rows that are the same finding into one
 * table row. A typical case is a /16 of gateway addresses whose PTRs all
 * name one host that no longer has an A record: 28 orphan rows that differ
 * only in the address. Listing them one by one buries every other finding,
 * so the page shows the first address and "+ 27 others" instead.
 *
 * Only statuses whose rows are interchangeable apart from the address are
 * folded: `orphan` (same PTR target, nothing forward), `mismatch` (same wrong
 * target, same forward names, same suggested fix) and `unhosted` (same
 * forward names, same upstream answer). `ok`, `missing` and `ambiguous` rows
 * stay one per address: an ambiguous row carries its own pick, and the
 * operator reads ok and missing rows per address.
 *
 * The row shape is structural so this module stays free of the page's wire
 * types and of React, and runs in the plain node test project.
 */

export interface GroupableForward {
  name: string;
}

export interface GroupableExternal {
  status: string;
  targets?: readonly string[];
}

export interface GroupablePtrRow {
  id: string;
  ip: string;
  family: 4 | 6;
  status: string;
  horizon: string;
  reverseZone: string | null;
  reverseServer: string | null;
  forward: readonly GroupableForward[];
  currentTargets: readonly string[];
  suggestedTarget: string | null;
  canWrite: boolean;
  external?: GroupableExternal;
}

export interface PtrRowGroup<Row extends GroupablePtrRow> {
  /**
   * Stable across re-fetches as long as the finding is unchanged, so an open
   * accordion or modal survives the realtime refresh. A singleton's id is
   * its row id.
   */
  id: string;
  /** The first member by address order; what the table shows and sorts by. */
  lead: Row;
  /** Every address in the group, in address order, the lead first. */
  members: Row[];
}

/** Statuses whose rows can share one table row. */
export const GROUPABLE_STATUSES: ReadonlySet<string> = new Set(["orphan", "mismatch", "unhosted"]);

/** Groups with fewer members than this are shown as plain rows. */
export const MIN_GROUP_SIZE = 2;

/** How many entries a table cell lists before "+ N more". */
export const CELL_PREVIEW_LIMIT = 3;

const IPV4_OCTETS = 4;
const IPV6_HEXTETS = 8;
const HEXTET_WIDTH = 4;

function sortedLower(values: Iterable<string>): string[] {
  return [...new Set([...values].map((v) => v.toLowerCase()))].sort();
}

/**
 * The key two rows must share to be folded together, or null when the row's
 * status is never folded.
 */
export function ptrGroupKey(row: GroupablePtrRow): string | null {
  if (!GROUPABLE_STATUSES.has(row.status)) return null;
  const parts = [
    row.status,
    row.horizon,
    row.reverseZone ?? "",
    row.reverseServer ?? "",
    row.canWrite ? "w" : "r",
    sortedLower(row.currentTargets).join(","),
    sortedLower(row.forward.map((f) => f.name)).join(","),
  ];
  if (row.status === "mismatch") parts.push((row.suggestedTarget ?? "").toLowerCase());
  if (row.status === "unhosted") {
    // The Current PTR cell shows the lead's upstream answer for the whole
    // group, so members must agree on it, a pending lookup included.
    parts.push(
      row.external?.status ?? "pending",
      sortedLower(row.external?.targets ?? []).join(","),
    );
  }
  return `group:${parts.join("|")}`;
}

/**
 * Expand an IPv6 address to eight four-digit hextets ("2001:db8::1" →
 * "2001:0db8:0000:…:0001") so string order is numeric order. An embedded
 * IPv4 tail ("::ffff:192.0.2.1") is converted to its two hextets. Returns the
 * lowercased input unchanged when it does not parse.
 */
export function expandIpv6(address: string): string {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const v4Tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4Tail) {
    const [a, b, c, d] = v4Tail.slice(1).map(Number) as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, v4Tail.index)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return address.toLowerCase();
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = IPV6_HEXTETS - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return address.toLowerCase();
  const hextets = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (hextets.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return address.toLowerCase();
  return hextets.map((h) => h.padStart(HEXTET_WIDTH, "0")).join(":");
}

function ipv4Value(address: string): number | null {
  const octets = address.split(".");
  if (octets.length !== IPV4_OCTETS) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * Numeric address order: IPv4 before IPv6, IPv4 by octets (so 10.42.2.1
 * sorts before 10.42.10.1), IPv6 by its expanded form.
 */
export function compareAddresses(a: string, b: string): number {
  const a4 = ipv4Value(a);
  const b4 = ipv4Value(b);
  if (a4 !== null && b4 !== null) return a4 - b4;
  if (a4 !== null) return -1;
  if (b4 !== null) return 1;
  const a6 = expandIpv6(a);
  const b6 = expandIpv6(b);
  return a6 < b6 ? -1 : a6 > b6 ? 1 : 0;
}

/**
 * Fold rows that are the same finding into groups. Rows that cannot be
 * folded, and keys shared by fewer than `MIN_GROUP_SIZE` rows, come back as
 * singletons. Groups keep the position of their first row in the input, so
 * the table's own sort still decides the final order.
 *
 * @param enabled false returns every row as its own singleton (the "Group
 *   similar rows" toggle off).
 */
export function groupPtrRows<Row extends GroupablePtrRow>(
  rows: readonly Row[],
  enabled = true,
): Array<PtrRowGroup<Row>> {
  const buckets = new Map<string, Row[]>();
  const order: Array<{ key: string } | { row: Row }> = [];
  for (const row of rows) {
    const key = enabled ? ptrGroupKey(row) : null;
    if (key === null) {
      order.push({ row });
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else {
      buckets.set(key, [row]);
      order.push({ key });
    }
  }
  const groups: Array<PtrRowGroup<Row>> = [];
  for (const entry of order) {
    if ("row" in entry) {
      groups.push({ id: entry.row.id, lead: entry.row, members: [entry.row] });
      continue;
    }
    const bucket = buckets.get(entry.key) ?? [];
    if (bucket.length < MIN_GROUP_SIZE) {
      for (const row of bucket) groups.push({ id: row.id, lead: row, members: [row] });
      continue;
    }
    const members = [...bucket].sort((x, y) => compareAddresses(x.ip, y.ip));
    groups.push({ id: entry.key, lead: members[0]!, members });
  }
  return groups;
}

export type GroupSelection = "none" | "some" | "all";

/** Whether none, some or all of a group's members are selected; drives the indeterminate box. */
export function groupSelectionState(
  members: ReadonlyArray<{ id: string }>,
  selected: ReadonlySet<string>,
): GroupSelection {
  let count = 0;
  for (const m of members) if (selected.has(m.id)) count++;
  if (count === 0) return "none";
  return count === members.length ? "all" : "some";
}

/** "+ 1 other", "+ 27 others": the count after a group's first address. */
export function othersLabel(others: number): string {
  return `+ ${others} ${others === 1 ? "other" : "others"}`;
}

/** "+ 4 more": the button after a capped cell list. */
export function moreLabel(hidden: number): string {
  return `+ ${hidden} more`;
}

/** "Remove PTR" for one address, "Remove 28 PTRs" for several. */
export function bulkActionLabel(verb: "Write" | "Remove", count: number): string {
  return count === 1 ? `${verb} PTR` : `${verb} ${count} PTRs`;
}

/** The first `limit` items and how many were left out, for a capped cell list. */
export function previewList<T>(
  items: readonly T[],
  limit = CELL_PREVIEW_LIMIT,
): { shown: T[]; hidden: number } {
  if (items.length <= limit) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}
