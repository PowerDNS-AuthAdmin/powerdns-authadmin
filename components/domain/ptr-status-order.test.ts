import { describe, expect, it } from "vitest";
import { orderStatusChips, PTR_STATUS_ORDER } from "./ptr-status-order";

const counts = (c: Partial<Record<(typeof PTR_STATUS_ORDER)[number], number>>) => ({
  missing: 0,
  mismatch: 0,
  ambiguous: 0,
  orphan: 0,
  ok: 0,
  unhosted: 0,
  ...c,
});

describe("orderStatusChips", () => {
  it("keeps the usual order while counts load", () => {
    expect(orderStatusChips(null)).toEqual(PTR_STATUS_ORDER);
  });

  it("puts Not hosted after OK even when it is larger, then the empty statuses", () => {
    expect(orderStatusChips(counts({ orphan: 27, ok: 54, unhosted: 84 }))).toEqual([
      "ok",
      "unhosted",
      "orphan",
      "missing",
      "mismatch",
      "ambiguous",
    ]);
  });

  it("orders by count, highest first, with the usual order breaking ties", () => {
    expect(
      orderStatusChips(
        counts({ missing: 3, mismatch: 9, ambiguous: 3, orphan: 1, ok: 40, unhosted: 2 }),
      ),
    ).toEqual(["ok", "mismatch", "missing", "ambiguous", "unhosted", "orphan"]);
  });

  it("leaves Not hosted where its count puts it when it is already behind them", () => {
    expect(orderStatusChips(counts({ ok: 10, unhosted: 4, orphan: 6 }))).toEqual([
      "ok",
      "orphan",
      "unhosted",
      "missing",
      "mismatch",
      "ambiguous",
    ]);
  });

  it("sends an empty Not hosted to the end with the other empty statuses", () => {
    expect(orderStatusChips(counts({ missing: 2 }))).toEqual([
      "missing",
      "mismatch",
      "ambiguous",
      "orphan",
      "ok",
      "unhosted",
    ]);
  });
});
