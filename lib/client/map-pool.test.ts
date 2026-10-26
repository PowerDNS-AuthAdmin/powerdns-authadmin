import { describe, expect, it } from "vitest";
import { mapPool } from "./map-pool";

describe("mapPool", () => {
  it("keeps input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapPool([], 3, () => Promise.resolve(1))).toEqual([]);
  });
});
