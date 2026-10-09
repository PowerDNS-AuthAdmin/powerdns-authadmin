/**
 * lib/db/backup-codec.ts
 *
 * JSON (de)serialisation rules for the app-DB backup bundle produced by
 * `GET /api/admin/backup/export` and consumed by `POST /api/admin/backup/restore`.
 *
 * Two things JSON cannot carry natively, decided here so both routes agree:
 *
 *   - `bigint` - Postgres `bigserial` ids (`audit_log.id`) come back from
 *     drizzle as BigInt, which `JSON.stringify` refuses to serialise. They go
 *     out as decimal strings and come back as BigInt.
 *   - `Date` - timestamps go out as ISO strings. On the way back, which keys
 *     hold dates is decided from the table's column metadata (`dataType ===
 *     "date"`), not from the key's spelling: rows carry drizzle *property*
 *     names (`createdAt`, `lockedUntil`, `ts`), so a `*_at` suffix heuristic
 *     never matched anything and every row failed at the driver's
 *     `value.toISOString()`.
 *
 * Pure - no I/O - so the mapping is unit-testable against the real tables.
 */

import { getTableColumns, type Column, type Table } from "drizzle-orm";

/** `getTableColumns` on a generic `Table` loses the column type; restore it. */
export function tableColumnEntries(table: Table): Array<[string, Column]> {
  return Object.entries(getTableColumns(table)) as Array<[string, Column]>;
}

/**
 * `JSON.stringify` replacer for the export. Dates become ISO strings (their
 * own `toJSON` would too; made explicit so the format is a contract), BigInts
 * become decimal strings.
 */
export function backupJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Project a restored row onto `table`'s real columns and convert JSON-carried
 * scalars back to what the column's driver mapping expects.
 *
 * Keys are matched against the table's property names before any write, so a
 * key taken from the uploaded JSON can never name a property outside that
 * fixed allowlist (`__proto__` / `constructor` are not columns and are
 * dropped). Values that can't be converted are passed through unchanged so the
 * database, not this function, rejects the row and the route reports it.
 */
export function normalizeBackupRow(
  table: Table,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of tableColumnEntries(table)) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const value = row[key];
    if (value === undefined) continue;
    out[key] = coerceForColumn(column.dataType, value);
  }
  return out;
}

function coerceForColumn(dataType: string, value: unknown): unknown {
  if (value === null) return null;
  if (dataType === "date") {
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    return value;
  }
  if (dataType === "bigint") {
    if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
    return value;
  }
  return value;
}
