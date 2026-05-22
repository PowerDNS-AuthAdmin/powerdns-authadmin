/**
 * drizzle.sqlite.config.ts
 *
 * Drizzle Kit config for the SQLite variant. Mirrors `drizzle.config.ts` but
 * points at the SQLite schema directory and writes migrations to `drizzle-sqlite/`.
 *
 * The two dialects deliberately have separate migration histories — the SQL
 * differs (no enums, no jsonb operators, different default expressions) and a
 * single migration file can't satisfy both. Operators choose one DATABASE_URL
 * shape and stick with it; cross-dialect migration is a manual data export +
 * re-import, not something the migration runner attempts.
 */

import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.local and set it.");
}

// Strip the `file:` prefix; drizzle-kit's sqlite driver wants a filesystem path.
const sqlitePath = databaseUrl.replace(/^(file|sqlite):\/?\/?/, "");

export default defineConfig({
  schema: "./lib/db/schema-sqlite/index.ts",
  out: "./drizzle-sqlite",
  dialect: "sqlite",
  dbCredentials: { url: sqlitePath || "./powerdns_authadmin.db" },
  verbose: true,
  strict: true,
});
