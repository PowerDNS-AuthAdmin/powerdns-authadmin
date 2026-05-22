/**
 * scripts/migrate.ts
 *
 * Programmatic migration runner. Picks the driver + migrations directory
 * from `DATABASE_URL`:
 *
 *   - `postgres://...` / `postgresql://...` → drizzle-orm/node-postgres + drizzle/
 *   - `file:...` / `sqlite:...`             → drizzle-orm/better-sqlite3 + drizzle-sqlite/
 *
 * Used by:
 *   - `npm run db:migrate` — operator-driven invocation
 *   - The app container entrypoint at boot (ADR-0011) — same script, no
 *     special-casing needed
 *
 * For Postgres in multi-instance deployments, the migrate step takes a
 * `pg_advisory_lock` so only one pod actually applies migrations even if
 * several boot simultaneously. SQLite is single-writer so no lock is needed.
 *
 * Logging is deliberately loud: a list of pending migrations before the
 * run, a list of applied migrations after, an explicit "0 pending — DB is
 * up to date" when there's nothing to do. A silent migrate hid a missing
 * column once; the louder shape lets `docker compose logs app | grep
 * migrate` answer "did the migration run?" without psql digging.
 */

import { dialectFromUrl } from "@/lib/db/_dialect";
import { logger } from "@/lib/logger";
import { diffByOrdinal, readJournal } from "@/lib/db/migration-status";

const MIGRATIONS_DIR_PG = "./drizzle";
const MIGRATIONS_DIR_SQLITE = "./drizzle-sqlite";

function stripSqlitePrefix(url: string): string {
  let s = url;
  if (s.startsWith("sqlite:")) s = s.slice("sqlite:".length);
  else if (s.startsWith("file:")) s = s.slice("file:".length);
  if (s.startsWith("///")) return s.slice(2);
  if (s.startsWith("//")) return s.slice(2);
  return s;
}

/**
 * Advisory-lock key for the Postgres migration step. Stable int8; concurrent
 * migrate processes serialize on the same lock.
 */
const PG_MIGRATE_ADVISORY_KEY = "31745931495632974";

async function migratePostgres(databaseUrl: string): Promise<void> {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");

  const journal = readJournal(MIGRATIONS_DIR_PG);
  logger.info(
    {
      dir: MIGRATIONS_DIR_PG,
      total: journal.length,
      tags: journal.map((e) => e.tag),
    },
    "migrate.pg.journal",
  );

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [PG_MIGRATE_ADVISORY_KEY.toString()]);
      logger.info({ dir: MIGRATIONS_DIR_PG }, "migrate.pg.lock-acquired");

      // Snapshot the applied count BEFORE running so we can log the delta.
      const beforeCount = await readAppliedCountPg(client);
      const beforeStatus = diffByOrdinal(journal, beforeCount);
      if (beforeStatus.pending.length === 0) {
        logger.info({ applied: beforeCount, total: journal.length }, "migrate.pg.up-to-date");
      } else {
        logger.info(
          { pending: beforeStatus.pending, count: beforeStatus.pending.length },
          "migrate.pg.pending",
        );
      }

      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR_PG });

      // Re-read to confirm Drizzle actually applied what we expected.
      const afterCount = await readAppliedCountPg(client);
      const justApplied = journal.slice(beforeCount, afterCount).map((e) => e.tag);
      logger.info(
        {
          applied: justApplied,
          appliedCount: justApplied.length,
          totalApplied: afterCount,
          totalExpected: journal.length,
        },
        "migrate.pg.complete",
      );

      const finalStatus = diffByOrdinal(journal, afterCount);
      if (finalStatus.pending.length > 0) {
        // This should never happen — Drizzle's migrate is supposed to apply
        // everything pending. Loud warning so an operator notices.
        logger.error({ stillPending: finalStatus.pending }, "migrate.pg.incomplete");
        throw new Error(
          `Drizzle migrate returned but ${finalStatus.pending.length} migration(s) are still pending: ${finalStatus.pending.join(", ")}`,
        );
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [PG_MIGRATE_ADVISORY_KEY.toString()]);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function readAppliedCountPg(client: {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<number> {
  try {
    const result = await client.query(
      "SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    const n = result.rows[0]?.["n"];
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

async function migrateSqlite(databaseUrl: string): Promise<void> {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const journal = readJournal(MIGRATIONS_DIR_SQLITE);
  logger.info(
    {
      dir: MIGRATIONS_DIR_SQLITE,
      total: journal.length,
      tags: journal.map((e) => e.tag),
    },
    "migrate.sqlite.journal",
  );

  const filePath = stripSqlitePrefix(databaseUrl);
  const handle = new Database(filePath);
  try {
    handle.pragma("journal_mode = WAL");
    handle.pragma("busy_timeout = 5000");
    handle.pragma("foreign_keys = ON");

    const beforeCount = readAppliedCountSqlite(handle);
    const beforeStatus = diffByOrdinal(journal, beforeCount);
    if (beforeStatus.pending.length === 0) {
      logger.info(
        { applied: beforeCount, total: journal.length, file: filePath },
        "migrate.sqlite.up-to-date",
      );
    } else {
      logger.info(
        { pending: beforeStatus.pending, count: beforeStatus.pending.length, file: filePath },
        "migrate.sqlite.pending",
      );
    }

    const db = drizzle(handle);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR_SQLITE });

    const afterCount = readAppliedCountSqlite(handle);
    const justApplied = journal.slice(beforeCount, afterCount).map((e) => e.tag);
    logger.info(
      {
        applied: justApplied,
        appliedCount: justApplied.length,
        totalApplied: afterCount,
        totalExpected: journal.length,
        file: filePath,
      },
      "migrate.sqlite.complete",
    );

    const finalStatus = diffByOrdinal(journal, afterCount);
    if (finalStatus.pending.length > 0) {
      logger.error({ stillPending: finalStatus.pending }, "migrate.sqlite.incomplete");
      throw new Error(
        `Drizzle migrate returned but ${finalStatus.pending.length} migration(s) are still pending: ${finalStatus.pending.join(", ")}`,
      );
    }
  } finally {
    handle.close();
  }
}

function readAppliedCountSqlite(handle: {
  prepare: (sql: string) => { get: () => Record<string, unknown> | undefined };
}): number {
  try {
    const row = handle.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
    const n = row?.["n"];
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    logger.error("migrate.failed: DATABASE_URL is not set");
    process.exit(1);
  }
  const dialect = dialectFromUrl(databaseUrl);
  logger.info({ dialect }, "migrate.start");
  if (dialect === "sqlite") {
    await migrateSqlite(databaseUrl);
  } else {
    await migratePostgres(databaseUrl);
  }
}

void main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "migrate.failed");
  process.exit(1);
});
