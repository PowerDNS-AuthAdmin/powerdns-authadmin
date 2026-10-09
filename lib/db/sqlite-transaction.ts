/**
 * lib/db/sqlite-transaction.ts
 *
 * Real BEGIN/COMMIT/ROLLBACK transactions for the better-sqlite3 path.
 *
 * better-sqlite3's own `transaction()` helper is synchronous and rejects an
 * async callback ("Transaction function cannot return a promise"). The app's
 * write+audit pattern is `db.transaction(async (tx) => …)` (~46 call sites),
 * so we can't hand the callback to it directly. This wraps the async callback
 * in an explicit transaction on the raw connection, restoring the atomicity
 * the DbExecutor pattern (mutation + `appendAudit` committing together) and the
 * "exactly one default backend" invariant depend on. Previously `transaction`
 * was a no-op that ran the callback with no transaction boundary, so each
 * statement autocommitted and a failed `appendAudit` left the mutation
 * committed with no audit trail.
 *
 * Serialization: one SQLite connection cannot hold two overlapping
 * transactions, and the callbacks are async, so two requests could otherwise
 * interleave their BEGIN/COMMIT across `await` points. Top-level transactions
 * are therefore queued through a promise chain and run strictly one at a time -
 * which is also SQLite's real concurrency model (a single writer).
 *
 * Nesting: a callback that itself calls `db.transaction` would deadlock on the
 * chain (it would await a promise that can't settle until the callback
 * returns), so a nested call takes a SAVEPOINT and skips the chain. "Nested"
 * is decided with an AsyncLocalStorage frame opened for the outer callback,
 * not with a shared counter: a counter can't tell a nested call apart from an
 * unrelated request that starts a transaction while the outer callback is
 * suspended on some non-DB `await` (an outbound HTTP call, a timer), and
 * would have merged that request's writes into the open transaction as a
 * SAVEPOINT. The async context follows the call chain, so only a call made
 * from inside the callback sees the frame.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The slice of the better-sqlite3 connection this needs. */
export interface SqliteExecHandle {
  exec(sql: string): unknown;
}

/** Per-top-level-transaction frame; `depth` names nested SAVEPOINTs uniquely. */
interface TransactionFrame {
  depth: number;
}

/**
 * Build a drop-in replacement for Drizzle's `db.transaction` on the
 * better-sqlite3 driver. The caller casts the result to the Drizzle
 * `transaction` signature; the runtime contract is `(callback) => Promise`.
 */
export function createSqliteTransactionRunner<TDb>(
  handle: SqliteExecHandle,
  db: TDb,
): (callback: (tx: TDb) => unknown) => Promise<unknown> {
  // The tail of the serialized transaction chain. Each new top-level
  // transaction chains onto it so they never overlap on the single connection.
  let tail: Promise<unknown> = Promise.resolve();
  // Set only for code running inside an open transaction's callback.
  const frames = new AsyncLocalStorage<TransactionFrame>();

  return (callback) => {
    // Nested: we're inside a transaction callback on this connection (the
    // BEGIN is open). Use a SAVEPOINT for partial-rollback semantics and skip
    // the chain - re-entering it would deadlock.
    const frame = frames.getStore();
    if (frame) {
      const savepoint = `app_sp_${frame.depth}`;
      frame.depth += 1;
      const runNested = async () => {
        handle.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(db);
          handle.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (err) {
          handle.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          handle.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw err;
        } finally {
          frame.depth -= 1;
        }
      };
      return runNested();
    }

    const runTop = () =>
      frames.run({ depth: 1 }, async () => {
        handle.exec("BEGIN");
        try {
          const result = await callback(db);
          handle.exec("COMMIT");
          return result;
        } catch (err) {
          // A constraint violation can make SQLite auto-rollback the transaction;
          // a follow-up ROLLBACK then throws "cannot rollback - no transaction is
          // active". Swallow that so the original error is what propagates.
          try {
            handle.exec("ROLLBACK");
          } catch {
            /* transaction already rolled back by SQLite */
          }
          throw err;
        }
      });

    // Run after any in-flight transaction settles, success or failure.
    const result = tail.then(runTop, runTop);
    // Keep the chain alive without forwarding this transaction's result/error
    // to the next link (each caller awaits its own `result`).
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
