/**
 * lib/db/migration-status.ts
 *
 * Compare what's on disk (`meta/_journal.json`) against what the database
 * believes is applied (`__drizzle_migrations`). Used in two places:
 *
 *   - `scripts/migrate.ts` — log pending list before running, applied list
 *     after, so an operator tailing `docker compose logs app | grep migrate`
 *     can see whether a migration actually ran.
 *   - `instrumentation.ts` — Next.js startup hook. If the journal lists
 *     migrations the DB doesn't have applied, emit a loud warning (and
 *     refuse to boot when MIGRATION_CHECK_STRICT=true). Protects against
 *     the entrypoint silently skipping migrate.
 *
 * The two callers want slightly different views, so this module exports
 * primitives + a high-level summary.
 */

import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface MigrationStatus {
  /** Migrations listed in meta/_journal.json (the on-disk truth). */
  expected: JournalEntry[];
  /** Tags the DB reports as applied (from __drizzle_migrations). */
  applied: string[];
  /** Tags in expected but not in applied. */
  pending: string[];
  /** Tags in applied but not in expected (recovery / out-of-band ops). */
  unknown: string[];
}

/**
 * Parse `meta/_journal.json` from a Drizzle migrations folder. Returns the
 * entries in idx order. Throws if the file is missing or malformed — both
 * cases mean the runtime can't trust the migration story.
 */
export function readJournal(migrationsDir: string): JournalEntry[] {
  const path = join(migrationsDir, "meta", "_journal.json");
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error(`Migration journal at ${path} is missing the "entries" array.`);
  }
  const entries = (parsed as { entries: unknown[] }).entries;
  return entries
    .map((e): JournalEntry => {
      if (!e || typeof e !== "object") {
        throw new Error(`Migration journal at ${path} has a non-object entry.`);
      }
      const o = e as Record<string, unknown>;
      if (typeof o["idx"] !== "number" || typeof o["tag"] !== "string") {
        throw new Error(`Migration journal at ${path} has an entry missing idx/tag.`);
      }
      return {
        idx: o["idx"],
        tag: o["tag"],
        when: typeof o["when"] === "number" ? o["when"] : 0,
      };
    })
    .sort((a, b) => a.idx - b.idx);
}

/**
 * Diff the on-disk journal against a list of applied tags. Pure — exported
 * for tests + reused by both callers.
 */
export function buildStatus(expected: JournalEntry[], applied: readonly string[]): MigrationStatus {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected.map((e) => e.tag));
  return {
    expected,
    applied: [...applied],
    pending: expected.filter((e) => !appliedSet.has(e.tag)).map((e) => e.tag),
    unknown: applied.filter((tag) => !expectedSet.has(tag)),
  };
}

/**
 * Read the applied migration tags from a Postgres database. Returns an
 * empty array when the `__drizzle_migrations` table doesn't exist yet
 * (fresh DB, before any migrate has run).
 *
 * Drizzle stores each applied migration as a row with `hash` (sha256 of
 * the SQL) and `created_at` (ms). The journal tag isn't recorded by
 * Drizzle, so we look the tag up via the journal entries' hashes by
 * comparing SQL contents — but the simpler proxy (rows = tags applied
 * by ordinal) is good enough for status display.
 */
export async function readAppliedTagsPostgres(client: {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<string[]> {
  try {
    // Drizzle's PG migrator creates this table in the `drizzle` schema.
    const result = await client.query(
      "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    );
    // Drizzle doesn't persist tags — we only know the COUNT of applied.
    // Return a placeholder list of the right length so the diff math works
    // against `expected[].tag` by index, not by name.
    return result.rows.map((_, i) => `idx-${i}`);
  } catch {
    return [];
  }
}

/** Same as readAppliedTagsPostgres but for better-sqlite3. */
export function readAppliedTagsSqlite(handle: {
  prepare: (sql: string) => { all: () => Array<Record<string, unknown>> };
}): string[] {
  try {
    const rows = handle.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY id").all();
    return rows.map((_, i) => `idx-${i}`);
  } catch {
    return [];
  }
}

/**
 * High-level: compare journal vs DB-applied counts and return a
 * summary. The journal-vs-applied diff is by ORDINAL — Drizzle doesn't
 * persist tags, only hashes — so a journal of length 2 against an
 * applied count of 1 marks the last journal entry as pending. That's
 * the case we care about ("the new migration didn't run").
 */
export function diffByOrdinal(expected: JournalEntry[], appliedCount: number): MigrationStatus {
  const pseudoApplied = Array.from(
    { length: appliedCount },
    (_, i) => expected[i]?.tag ?? `idx-${i}`,
  );
  return buildStatus(expected, pseudoApplied);
}
