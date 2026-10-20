/**
 * components/domain/ptr-status-order.ts
 *
 * The order of the Reverse DNS status chips. Counts drive it, so the biggest
 * pile is the first thing the eye lands on; "Not hosted" (addresses no hosted
 * reverse zone covers, so nothing here can fix them) never jumps ahead of the
 * statuses an operator acts on or checks; empty statuses trail in their usual
 * order. Pure, unit-tested.
 */

export type PtrChipStatus = "missing" | "mismatch" | "ambiguous" | "orphan" | "ok" | "unhosted";

/** The usual order: the fixed fallback while counts load, and the tie-breaker. */
export const PTR_STATUS_ORDER: readonly PtrChipStatus[] = [
  "missing",
  "mismatch",
  "ambiguous",
  "orphan",
  "ok",
  "unhosted",
];

/** Statuses "Not hosted" always follows when they have a count. */
const BEFORE_UNHOSTED: ReadonlySet<PtrChipStatus> = new Set([
  "missing",
  "mismatch",
  "ambiguous",
  "ok",
]);

export function orderStatusChips(
  counts: Readonly<Record<PtrChipStatus, number>> | null,
): PtrChipStatus[] {
  if (!counts) return [...PTR_STATUS_ORDER];
  const rank = (s: PtrChipStatus) => PTR_STATUS_ORDER.indexOf(s);
  const nonZero = PTR_STATUS_ORDER.filter((s) => counts[s] > 0).sort(
    (a, b) => counts[b] - counts[a] || rank(a) - rank(b),
  );
  const zero = PTR_STATUS_ORDER.filter((s) => counts[s] <= 0);

  const at = nonZero.indexOf("unhosted");
  if (at !== -1) {
    nonZero.splice(at, 1);
    let lastRequired = -1;
    nonZero.forEach((s, i) => {
      if (BEFORE_UNHOSTED.has(s)) lastRequired = i;
    });
    nonZero.splice(Math.max(at, lastRequired + 1), 0, "unhosted");
  }
  return [...nonZero, ...zero];
}
