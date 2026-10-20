/**
 * components/domain/chip-order.ts
 *
 * The shared ordering rule for count-driven filter chips (Reverse DNS
 * statuses, Zone Monitoring verdicts): the biggest pile first, so it is the
 * first thing the eye lands on; one "passive" bucket (something nothing on
 * the page acts on) never jumps ahead of the buckets an operator acts on or
 * checks; empty buckets trail in their usual order. Pure, unit-tested.
 */

export interface ChipOrderRule<T extends string> {
  /** The usual order: the tie-breaker, and the order of the empty buckets. */
  order: readonly T[];
  /** A bucket that never precedes any of `passiveAfter` while they have a count. */
  passive?: T;
  passiveAfter?: ReadonlySet<T>;
}

export function orderChipsByCount<T extends string>(
  rule: ChipOrderRule<T>,
  counts: Readonly<Record<T, number>>,
): T[] {
  const { order, passive, passiveAfter } = rule;
  const rank = (s: T) => order.indexOf(s);
  const nonZero = order
    .filter((s) => counts[s] > 0)
    .sort((a, b) => counts[b] - counts[a] || rank(a) - rank(b));
  const zero = order.filter((s) => counts[s] <= 0);

  const at = passive === undefined ? -1 : nonZero.indexOf(passive);
  if (passive !== undefined && at !== -1) {
    nonZero.splice(at, 1);
    let lastRequired = -1;
    nonZero.forEach((s, i) => {
      if (passiveAfter?.has(s)) lastRequired = i;
    });
    nonZero.splice(Math.max(at, lastRequired + 1), 0, passive);
  }
  return [...nonZero, ...zero];
}
