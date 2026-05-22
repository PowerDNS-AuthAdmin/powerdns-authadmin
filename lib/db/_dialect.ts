/**
 * lib/db/_dialect.ts
 *
 * Reads `DATABASE_URL` once at import time and decides which dialect the app
 * is talking to. The result is consumed by both `lib/db/index.ts` (which
 * driver to construct) and `lib/db/schema/index.ts` (which table objects to
 * re-export).
 *
 * Why a separate module: we need a coherent answer to "Postgres or SQLite?"
 * BEFORE `lib/env.ts` runs (env validation runs side effects that depend on
 * what's expected). This file reads `process.env.DATABASE_URL` directly with
 * a tiny prefix check; no Zod, no schema.
 *
 * URL forms:
 *   - `postgres://...`  / `postgresql://...`  → Postgres
 *   - `file:./path.db`  / `file:/abs/path.db` / `sqlite:./path.db` → SQLite
 */

export type DbDialect = "postgres" | "sqlite";

/**
 * Compute the dialect from a URL string. Exported so tests can exercise the
 * branching without touching `process.env`.
 */
export function dialectFromUrl(url: string | undefined | null): DbDialect {
  if (!url) return "postgres"; // safe default; env validation will fail anyway if truly missing
  if (url.startsWith("file:") || url.startsWith("sqlite:")) return "sqlite";
  return "postgres";
}

/** The active dialect for this process. Snapshot at module load. */
export const dialect: DbDialect = dialectFromUrl(process.env["DATABASE_URL"]);

/** Convenience boolean — concise check at call sites. */
export const isSqlite: boolean = dialect === "sqlite";
