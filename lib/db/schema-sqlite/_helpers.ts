/**
 * lib/db/schema-sqlite/_helpers.ts
 *
 * SQLite mirrors of the Postgres column helpers. See `../schema/_helpers.ts`
 * for the source-of-truth conventions; the only differences here are:
 *
 *  - UUIDs are stored as TEXT and generated in JS (`crypto.randomUUID`).
 *    SQLite has no `uuid` type and no equivalent of `gen_random_uuid()`.
 *  - Timestamps store milliseconds-since-epoch as INTEGER. Drizzle's
 *    `timestamp_ms` mode hands callers `Date` instances on both sides
 *    of the wire, so repository code doesn't care that the storage
 *    type differs from Postgres' `timestamptz`.
 */

import { integer, text } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

/** UUID primary key generated in app code (no SQLite-native UUID). */
export const pk = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

/** Standard created_at / updated_at columns. */
export const timestamps = () => ({
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
