/**
 * lib/db/sql-dialect.ts
 *
 * Tiny helpers for the few places where Postgres and SQLite need different
 * raw SQL. Each helper returns a Drizzle `sql` fragment composed with the
 * active dialect's syntax.
 *
 * Prefer the high-level Drizzle query API where possible — these helpers are
 * for cases where the API surfaces a dialect quirk (`::text` cast, JSON
 * extract operators, hour-bucket truncation, etc.).
 */

import "server-only";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { dialect, isSqlite } from "./_dialect";

export { dialect, isSqlite };

/**
 * Cast a column or expression to text in the running dialect. Postgres uses
 * the `::text` cast; SQLite uses `CAST(x AS TEXT)`.
 */
export function castToText(col: AnyColumn | SQL): SQL<string> {
  return isSqlite ? sql<string>`CAST(${col} AS TEXT)` : sql<string>`${col}::text`;
}

/**
 * Cast nullable column/expression to text — preserves nullability in the type.
 */
export function castToNullableText(col: AnyColumn | SQL): SQL<string | null> {
  return isSqlite ? sql<string | null>`CAST(${col} AS TEXT)` : sql<string | null>`${col}::text`;
}

/**
 * `count(*)` projected as a JS number.
 *
 * Postgres returns `count(*)` as `bigint`, which the pg-types parser hands
 * back as a string — we cast to `int` so the driver decodes to a JS number.
 * SQLite returns counts natively as numbers, so no cast is needed.
 *
 * Callers must still `Number(row.count)` if the column might end up larger
 * than `int4` (unlikely for the use cases here — admin-table counts).
 */
export function countStar(): SQL<number> {
  return isSqlite ? sql<number>`count(*)` : sql<number>`count(*)::int`;
}

/**
 * Extract a top-level string field from a JSON column in the active dialect.
 * Postgres uses `->>`; SQLite uses `json_extract(col, '$.key')`. The key is
 * embedded as a JSON-path component without escaping (call sites use
 * compile-time constant keys), so don't pass user input.
 */
export function jsonStringField(col: AnyColumn, key: string): SQL<string | null> {
  if (isSqlite) {
    return sql<string | null>`json_extract(${col}, ${`$.${key}`})`;
  }
  return sql<string | null>`(${col}->>${key})`;
}

/**
 * Extract a top-level boolean field from a JSON column. Returns 0/1 in
 * SQLite, true/false in Postgres — both compare-against-true work.
 */
export function jsonBoolField(col: AnyColumn, key: string): SQL<boolean> {
  if (isSqlite) {
    return sql<boolean>`json_extract(${col}, ${`$.${key}`})`;
  }
  return sql<boolean>`(${col}->>${key})::boolean`;
}

/**
 * Truncate a timestamp column to a unit (hour / day) for bucketing. Returns
 * a SQL fragment whose JS-decoded value is a `Date`.
 *
 * Postgres: `date_trunc('hour', ts)` — yields a UTC timestamptz.
 * SQLite (timestamp_ms storage): convert to seconds and truncate via
 *   strftime under `'unixepoch'`, which interprets the epoch as UTC and
 *   formats UTC wall-clock components. We emit an ISO-8601 string with a
 *   'T' separator and a trailing 'Z' so `new Date(string)` parses it back
 *   as UTC — without the 'Z', a space/`'YYYY-MM-DD HH:00:00'` string is
 *   parsed as LOCAL time, skewing every SQLite bucket by the server's
 *   offset relative to the Postgres path.
 */
export function truncToHour(col: AnyColumn): SQL<Date> {
  if (isSqlite) {
    return sql<Date>`strftime('%Y-%m-%dT%H:00:00Z', ${col} / 1000, 'unixepoch')`;
  }
  return sql<Date>`date_trunc('hour', ${col})`;
}
