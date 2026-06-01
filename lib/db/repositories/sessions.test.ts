import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "@/lib/db";
import { countActiveSessions } from "./sessions";

/**
 * Build a stand-in executor whose `select().from().where()` chain resolves to
 * `rows`. Casting through `unknown` keeps the test off a live DB without an
 * `any` (lint forbids it); we only exercise the count-extraction logic, not
 * Drizzle's SQL generation - that's the integration suite's job.
 */
function executorReturning(rows: Array<{ count: number }>): DbExecutor {
  const where = vi.fn(() => Promise.resolve(rows));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as DbExecutor;
}

describe("countActiveSessions", () => {
  it("returns the counted active-session total as a number", async () => {
    await expect(countActiveSessions(executorReturning([{ count: 7 }]))).resolves.toBe(7);
  });

  it("defaults to 0 when the count query yields no rows", async () => {
    // A count(*) always returns one row in real SQL, but guard the empty-array
    // edge so a future query shape change can't surface NaN to the dashboard.
    await expect(countActiveSessions(executorReturning([]))).resolves.toBe(0);
  });

  it("coerces a string count (some drivers stringify aggregates) to a number", async () => {
    const stringy = [{ count: "12" }] as unknown as Array<{ count: number }>;
    await expect(countActiveSessions(executorReturning(stringy))).resolves.toBe(12);
  });
});
