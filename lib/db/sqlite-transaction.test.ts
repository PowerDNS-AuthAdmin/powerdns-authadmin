/**
 * lib/db/sqlite-transaction.test.ts
 *
 * The portable cases drive a fake exec-handle that records the SQL it's asked
 * to run, so they assert the BEGIN/COMMIT/ROLLBACK ordering, top-level
 * serialization, and SAVEPOINT nesting without a native module - they run in
 * any environment.
 *
 * The final block opens a real in-memory better-sqlite3 database to prove
 * genuine atomicity (a thrown callback leaves no rows; concurrent "single
 * default" writers converge on exactly one). It's skipped where the native
 * binding can't load (e.g. an ABI mismatch in a dev sandbox); CI runs it.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type DatabaseDefault from "better-sqlite3";
import { createSqliteTransactionRunner } from "./sqlite-transaction";

function fakeHandle() {
  const calls: string[] = [];
  return {
    calls,
    exec(sql: string) {
      calls.push(sql);
    },
  };
}

const DB = { marker: "db" } as const;

describe("createSqliteTransactionRunner (fake handle)", () => {
  it("wraps a successful callback in BEGIN/COMMIT and returns its result", async () => {
    const h = fakeHandle();
    const run = createSqliteTransactionRunner(h, DB);

    const result = await run((tx) => {
      expect(tx).toBe(DB); // callback receives the db handle
      return "ok";
    });

    expect(result).toBe("ok");
    expect(h.calls).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rolls back and rethrows when the callback throws", async () => {
    const h = fakeHandle();
    const run = createSqliteTransactionRunner(h, DB);

    await expect(
      run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(h.calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("swallows a ROLLBACK error so the original error propagates", async () => {
    const calls: string[] = [];
    const h = {
      exec(sql: string) {
        calls.push(sql);
        // SQLite may have already auto-rolled-back on a constraint error.
        if (sql === "ROLLBACK") throw new Error("no transaction is active");
      },
    };
    const run = createSqliteTransactionRunner(h, DB);

    await expect(run(() => Promise.reject(new Error("constraint")))).rejects.toThrow("constraint");
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("serializes top-level transactions (never two open at once)", async () => {
    const h = fakeHandle();
    const run = createSqliteTransactionRunner(h, DB);

    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    const order: string[] = [];
    const t1 = run(async () => {
      order.push("t1-start");
      await gate1; // hold the first transaction open
      order.push("t1-end");
    });
    const t2 = run(() => {
      order.push("t2-start");
    });

    // While t1 holds the transaction, t2's callback must not have run and no
    // second BEGIN may have been issued.
    await Promise.resolve();
    expect(order).toEqual(["t1-start"]);
    expect(h.calls.filter((c) => c === "BEGIN")).toHaveLength(1);

    release1();
    await Promise.all([t1, t2]);

    expect(order).toEqual(["t1-start", "t1-end", "t2-start"]);
    // Strictly serialized - never BEGIN,BEGIN.
    expect(h.calls).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
  });

  it("uses a SAVEPOINT for a nested transaction and commits both", async () => {
    const h = fakeHandle();
    const run = createSqliteTransactionRunner(h, DB);

    const result = await run(async () => {
      const inner = (await run(() => "inner")) as string; // nested call on the same runner
      return `${inner}/outer`;
    });

    expect(result).toBe("inner/outer");
    expect(h.calls).toEqual([
      "BEGIN",
      "SAVEPOINT app_sp_1",
      "RELEASE SAVEPOINT app_sp_1",
      "COMMIT",
    ]);
  });

  it("rolls back only the inner SAVEPOINT when a nested transaction fails", async () => {
    const h = fakeHandle();
    const run = createSqliteTransactionRunner(h, DB);

    const result = await run(async () => {
      try {
        await run(() => {
          throw new Error("inner-fail");
        });
      } catch {
        // outer recovers and still commits
      }
      return "outer-ok";
    });

    expect(result).toBe("outer-ok");
    expect(h.calls).toEqual([
      "BEGIN",
      "SAVEPOINT app_sp_1",
      "ROLLBACK TO SAVEPOINT app_sp_1",
      "RELEASE SAVEPOINT app_sp_1",
      "COMMIT",
    ]);
  });
});

// --- Real better-sqlite3 (CI; skipped where the native binding can't load) ---
type DatabaseCtorType = typeof DatabaseDefault;
let DatabaseCtor: DatabaseCtorType | null = null;
try {
  const ctor = createRequire(import.meta.url)("better-sqlite3") as DatabaseCtorType;
  // The JS wrapper requires fine, but the native binding only loads on first
  // instantiation - so probe it here. An ABI mismatch (dev sandbox) then skips
  // the suite instead of failing it; CI's matching ABI runs it.
  new ctor(":memory:").close();
  DatabaseCtor = ctor;
} catch {
  DatabaseCtor = null;
}

describe.skipIf(DatabaseCtor === null)(
  "createSqliteTransactionRunner (real better-sqlite3)",
  () => {
    const Database = DatabaseCtor!;

    it("commits a successful transaction and rolls back a thrown one", async () => {
      const handle = new Database(":memory:");
      handle.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const run = createSqliteTransactionRunner(handle, handle);

      await run((tx) => {
        tx.prepare("INSERT INTO t (v) VALUES (?)").run("a");
      });
      expect((handle.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);

      await expect(
        run((tx) => {
          tx.prepare("INSERT INTO t (v) VALUES (?)").run("b");
          throw new Error("rollback me");
        }),
      ).rejects.toThrow("rollback me");
      // The "b" insert must have been rolled back - still exactly one row.
      expect((handle.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);

      handle.close();
    });

    it("keeps the single-default invariant under concurrent writers", async () => {
      const handle = new Database(":memory:");
      handle.exec(
        "CREATE TABLE backends (id INTEGER PRIMARY KEY, is_default INTEGER NOT NULL DEFAULT 0)",
      );
      handle.exec("INSERT INTO backends (id, is_default) VALUES (1, 1)");
      const run = createSqliteTransactionRunner(handle, handle);

      // Two concurrent "make me the only default" writers. With real, serialized
      // transactions the clear-then-set runs atomically, so exactly one row is
      // default afterwards (the no-op override could leave zero or two).
      const setDefault = (id: number) =>
        run((tx) => {
          tx.prepare("UPDATE backends SET is_default = 0 WHERE is_default = 1").run();
          tx.prepare("INSERT INTO backends (id, is_default) VALUES (?, 1)").run(id);
        });

      await Promise.all([setDefault(2), setDefault(3)]);

      expect(
        (
          handle.prepare("SELECT COUNT(*) AS c FROM backends WHERE is_default = 1").get() as {
            c: number;
          }
        ).c,
      ).toBe(1);

      handle.close();
    });
  },
);
