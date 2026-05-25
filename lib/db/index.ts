/**
 * lib/db/index.ts
 *
 * The single database connection + Drizzle instance. Every repository imports
 * `db` from here; nobody opens their own connection.
 *
 * Dialect dispatch (see `_dialect.ts`):
 *   - `postgres://...` / `postgresql://...` → node-postgres pool + drizzle-orm/node-postgres
 *   - `file:...`       / `sqlite:...`       → better-sqlite3 + drizzle-orm/better-sqlite3
 *
 * The exported `db` value is typed against the Postgres schema as the canonical
 * shape — at runtime, when SQLite is the dialect, the actual object is a
 * `BetterSQLite3Database` operating on the parallel sqlite-core tables in
 * `lib/db/schema-sqlite/`. The two schemas are structurally identical (same
 * column names, same JS-side row types modulo `bigint` ↔ `number` for the
 * autoincrement primary keys), so repository code that uses Drizzle's standard
 * query API works on both. Dialect-specific raw `sql\`...\`` strings live behind
 * `lib/db/sql-dialect.ts`.
 */

import "server-only";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
// `pg` is published as a CommonJS module. Named-import (`import { Pool } from "pg"`)
// works under Next's bundler but breaks under Node's pure ESM resolver (which
// `tsx` uses for our CLI scripts). Default-import + namespace access is the
// portable pattern.
import pg from "pg";
import { env } from "@/lib/env";
import { dialect } from "./_dialect";
import { createSqliteTransactionRunner } from "./sqlite-transaction";
import * as schema from "@/lib/db/schema";

type PgPool = InstanceType<typeof pg.Pool>;

/**
 * The exported `db` is typed against the Postgres schema as the canonical
 * shape — but at runtime under SQLite mode the actual value is a
 * BetterSQLite3Database operating on the parallel sqlite-core tables.
 */
export type AppDatabase = NodePgDatabase<typeof schema>;

/**
 * A query executor: either the shared `db` or an open transaction handle.
 * Repository mutations that participate in an audited write accept this
 * (defaulting to `db`) so a route can run the mutation AND its `appendAudit`
 * row inside one `db.transaction(...)` — making the state change and its audit
 * entry atomic (either both commit or neither does).
 */
export type DbExecutor = AppDatabase | Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

interface DbBundle {
  db: AppDatabase;
  pool: PgPool | null;
  sqliteHandle: Database.Database | null;
}

function stripSqlitePrefix(url: string): string {
  // Accepted forms:
  //   file:./foo.db        → ./foo.db (relative)
  //   file:foo.db          → foo.db    (relative)
  //   file:/abs/foo.db     → /abs/foo.db (absolute, "abbreviated" form)
  //   file:///abs/foo.db   → /abs/foo.db (RFC 8089 absolute form — strip the
  //                                       extra //, keep the leading /)
  //   sqlite:* — same shapes as file:.
  let s = url;
  if (s.startsWith("sqlite:")) s = s.slice("sqlite:".length);
  else if (s.startsWith("file:")) s = s.slice("file:".length);
  // Strip up to two leading slashes after the scheme (the `//` from
  // `file://host/path` is the authority-empty form). Keep the leading `/`
  // of an absolute path.
  if (s.startsWith("///")) return s.slice(2);
  if (s.startsWith("//")) return s.slice(2);
  return s;
}

function buildBundle(): DbBundle {
  if (dialect === "sqlite") {
    const filePath = stripSqlitePrefix(env.DATABASE_URL);
    const handle = new Database(filePath);
    // Concurrency: WAL gives one-writer / many-readers, much better than the
    // default rollback journal for a web app. busy_timeout lets readers wait
    // briefly when the writer holds the lock instead of failing immediately.
    handle.pragma("journal_mode = WAL");
    handle.pragma("busy_timeout = 5000");
    handle.pragma("foreign_keys = ON");
    const sqliteDb = drizzleSqlite(handle, {
      schema: schema as unknown as Record<string, never>,
    }) as unknown as AppDatabase;

    // better-sqlite3 transactions are SYNCHRONOUS and reject an async callback
    // ("Transaction function cannot return a promise"). The app's write+audit
    // pattern is async (it awaits the mutation, then `appendAudit`, inside one
    // `db.transaction(async (tx) => …)`) and is used by ~46 call sites plus the
    // seed/provision boot scripts. Replace `transaction` with a runner that
    // wraps the async callback in a real BEGIN/COMMIT/ROLLBACK (serialized,
    // since one connection can't hold overlapping transactions) so the mutation
    // and its audit row commit atomically — matching the Postgres path. See
    // ./sqlite-transaction.ts for the serialization + nesting details.
    sqliteDb.transaction = createSqliteTransactionRunner(
      handle,
      sqliteDb,
    ) as unknown as AppDatabase["transaction"];

    return { db: sqliteDb, pool: null, sqliteHandle: handle };
  }

  const pool: PgPool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  const db = drizzlePg(pool, { schema });
  return { db, pool, sqliteHandle: null };
}

const bundle = buildBundle();

export const db: AppDatabase = bundle.db;

/** Postgres pool — null in SQLite mode. Exposed for the migration runner. */
export const pool: PgPool | null = bundle.pool;

/**
 * Health probe. Used by `app/readyz/route.ts` to confirm DB reachability.
 * Returns `true` if a trivial query succeeds within the timeout.
 */
export async function pingDatabase(): Promise<boolean> {
  if (bundle.sqliteHandle) {
    try {
      bundle.sqliteHandle.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }
  if (!bundle.pool) return false;
  try {
    const client = await bundle.pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

/**
 * Close the connection. CLI scripts (seed, migrations) call this so the
 * process exits cleanly. The app server never calls it — Node handles
 * shutdown via SIGTERM and the framework's shutdown hooks.
 */
export async function closeDatabase(): Promise<void> {
  if (bundle.sqliteHandle) {
    bundle.sqliteHandle.close();
    return;
  }
  if (bundle.pool) await bundle.pool.end();
}

/**
 * Access the raw better-sqlite3 handle (SQLite mode only). Used by the
 * migration runner; repositories should NOT reach for this — go through
 * Drizzle's API instead.
 */
export function sqliteHandle(): Database.Database | null {
  return bundle.sqliteHandle;
}
