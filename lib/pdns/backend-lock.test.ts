/**
 * lib/pdns/backend-lock.test.ts
 *
 * The per-backend FIFO mutex: same-key operations never overlap and run in
 * order; different keys run concurrently; a thrown body still frees the slot.
 */

import { describe, expect, it } from "vitest";
import { withBackendLock } from "./backend-lock";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withBackendLock", () => {
  it("serializes same-key operations (no overlap) in FIFO order", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const op = (id: string, ms: number) =>
      withBackendLock("be-1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${id}`);
        await tick(ms);
        events.push(`end:${id}`);
        active -= 1;
      });

    await Promise.all([op("a", 30), op("b", 5), op("c", 5)]);

    expect(maxActive).toBe(1); // never two at once
    // FIFO: each op fully completes before the next starts.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("lets different keys run concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const op = (key: string) =>
      withBackendLock(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick(20);
        active -= 1;
      });

    await Promise.all([op("be-a"), op("be-b"), op("be-c")]);
    expect(maxActive).toBe(3); // distinct keys don't block each other
  });

  it("releases the slot even when the body throws", async () => {
    await expect(
      withBackendLock("be-throw", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    // The next caller still acquires the slot and runs.
    const ran = await withBackendLock("be-throw", () => Promise.resolve("ok"));
    expect(ran).toBe("ok");
  });

  it("returns the body's value", async () => {
    expect(await withBackendLock("be-val", () => Promise.resolve(42))).toBe(42);
  });
});
