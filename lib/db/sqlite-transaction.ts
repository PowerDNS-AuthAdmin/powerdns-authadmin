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
 * which is also SQLite's real concurrency model (a single writer). In practice
 * the callbacks only `await` better-sqlite3 queries, which resolve
 * synchronously, so nothing interleaves mid-transaction anyway; the chain is
 * belt-and-suspenders that also keeps a genuinely-async callback safe.
 *
 * Nesting: a callback that itself calls `db.transaction` would deadlock on the
 * chain (it would await a promise that can't settle until the callback
 * returns), so a nested call takes a SAVEPOINT and skips the chain. No call
 * site nests today; this keeps a future one correct. Detection assumes a
 * transaction callback never `await`s non-DB async work (true for this
 * codebase), so a concurrent top-level call is never mistaken for a nested one.
 */

/** The slice of the better-sqlite3 connection this needs. */
export interface SqliteExecHandle {
  exec(sql: string): unknown;
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
  // 0 = no transaction in flight; >0 = inside a transaction callback (the value
  // is the current nesting level, used to name SAVEPOINTs uniquely).
  let depth = 0;

  return (callback) => {
    // Nested: we're already inside a transaction callback on this connection
    // (the BEGIN is open). Use a SAVEPOINT for partial-rollback semantics and
    // skip the chain - re-entering it would deadlock.
    if (depth > 0) {
      const savepoint = `app_sp_${depth}`;
      depth += 1;
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
          depth -= 1;
        }
      };
      return runNested();
    }

    const runTop = async () => {
      depth = 1;
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
      } finally {
        depth = 0;
      }
    };

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
