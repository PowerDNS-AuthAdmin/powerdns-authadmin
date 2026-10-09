/**
 * lib/db/migrate-sqlite.ts
 *
 * The SQLite half of the migration runner (`scripts/migrate.ts` is the CLI
 * around it). Lives in `lib/` so the exact code path the container boots
 * through is unit-testable against a real on-disk database.
 *
 * Why foreign keys are switched OFF around `migrate()`: drizzle-kit emits
 * table rebuilds as `PRAGMA foreign_keys=OFF; CREATE __new; INSERT…SELECT;
 * DROP old; RENAME; PRAGMA foreign_keys=ON;`, and drizzle's synchronous
 * migrator runs every pending migration inside one `BEGIN … COMMIT`. SQLite
 * documents `PRAGMA foreign_keys` as a no-op inside a transaction, so the
 * in-migration OFF never takes effect. With enforcement still on, `DROP TABLE`
 * performs an implicit `DELETE FROM` that fires the children's `ON DELETE`
 * actions - release 1.1.0's `pdns_servers` rebuild silently emptied
 * `zone_grants`, `metric_samples` and `pdns_server_stats` and nulled
 * `pdns_requests.server_id`. The pragma therefore has to be set on the raw
 * connection BEFORE the migrator opens its transaction, and referential
 * integrity is verified explicitly afterwards (`PRAGMA foreign_key_check`),
 * which is exactly the procedure SQLite's own ALTER TABLE documentation
 * prescribes for table rebuilds.
 */

import "server-only";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { logger } from "@/lib/logger";
import { diffByOrdinal, readJournal } from "./migration-status";

export const MIGRATIONS_DIR_SQLITE = "./drizzle-sqlite";

export interface SqliteMigrationOutcome {
  /** Journal tags applied by this run (empty when the DB was up to date). */
  applied: string[];
  totalApplied: number;
  totalExpected: number;
}

/**
 * Apply every pending migration from `migrationsDir` to the SQLite database at
 * `filePath`. Loud logging, mirroring the Postgres path: pending list before,
 * applied list after, and an error if anything is still pending.
 *
 * @throws {Error} when a migration fails, when `PRAGMA foreign_key_check`
 *   reports violations after the run (the transaction has already committed by
 *   then - the error is so the operator sees it rather than a silently broken
 *   database), or when drizzle returns with migrations still pending.
 */
export function migrateSqliteDatabase(
  filePath: string,
  migrationsDir: string = MIGRATIONS_DIR_SQLITE,
): SqliteMigrationOutcome {
  const journal = readJournal(migrationsDir);
  logger.info(
    { dir: migrationsDir, total: journal.length, tags: journal.map((e) => e.tag) },
    "migrate.sqlite.journal",
  );

  const handle = new Database(filePath);
  try {
    handle.pragma("journal_mode = WAL");
    handle.pragma("busy_timeout = 5000");

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

    // Must be issued outside drizzle's BEGIN - see the module comment.
    handle.pragma("foreign_keys = OFF");
    try {
      migrate(drizzle(handle), { migrationsFolder: migrationsDir });
    } finally {
      // Re-enable regardless of outcome so a failed run can't leave the
      // connection (reused by a caller) without enforcement.
      handle.pragma("foreign_keys = ON");
    }

    const violations = handle.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      logger.error(
        { violations: violations.slice(0, 20), count: violations.length },
        "migrate.sqlite.foreign-key-violations",
      );
      throw new Error(
        `migrate.sqlite: ${violations.length} foreign-key violation(s) after migrate - the database needs manual repair before the app can run on it.`,
      );
    }

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

    return { applied: justApplied, totalApplied: afterCount, totalExpected: journal.length };
  } finally {
    handle.close();
  }
}

function readAppliedCountSqlite(handle: Database.Database): number {
  try {
    const row = handle.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
      | { n?: unknown }
      | undefined;
    const n = row?.n;
    return typeof n === "number" ? n : 0;
  } catch {
    // The migrations table doesn't exist yet - a fresh database.
    return 0;
  }
}
