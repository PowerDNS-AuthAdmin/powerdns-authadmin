/**
 * tests/integration/helpers/db.ts
 *
 * Direct Postgres access from the test process. Lets tests TRUNCATE user
 * data between cases and read rows for assertions that aren't exposed via
 * the API (audit log internals, raw role_assignments, etc.).
 *
 * Connection string mirrors the test compose's host port mapping
 * (postgres:5432 → localhost:5432). Override with TEST_DATABASE_URL if you
 * want to point at a different DB.
 */

import { Client } from "pg";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://pdns:pdns@localhost:5432/powerdns_authadmin";

export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Run a single query and return rows. Convenience for one-shot reads. */
export async function dbQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return withDb(async (c) => {
    const res = await c.query<R>(sql, params);
    return res.rows;
  });
}

/**
 * Wipe user-data tables but preserve the bootstrap admin + their global
 * super-admin role assignment. System-seed tables (roles, settings,
 * pdns_servers/clusters, oidc_providers, zone_templates) are kept intact
 * so tests don't have to re-create them every time.
 *
 * Order matters where FKs aren't ON DELETE CASCADE - but every test-data
 * table here either has cascading FKs onto users/teams, or is itself a
 * leaf. The single TRUNCATE statement with CASCADE handles the rest.
 */
export async function resetUserData(opts: { bootstrapEmail: string }): Promise<void> {
  await withDb(async (c) => {
    await c.query("BEGIN");
    try {
      // 1. Drop sessions, audit, tokens, metric samples (leaf-ish tables).
      await c.query(`
        TRUNCATE TABLE
          sessions,
          api_tokens,
          audit_log,
          pdns_requests,
          pdns_server_stats,
          metric_samples
        RESTART IDENTITY
      `);
      // 2. Drop team-related rows. Cascade handles team_members + zone_grants
      //    that reference teams.
      await c.query("TRUNCATE TABLE teams RESTART IDENTITY CASCADE");
      // 3. Drop role assignments + zone grants that target non-bootstrap users.
      await c.query(
        `DELETE FROM role_assignments WHERE user_id NOT IN
           (SELECT id FROM users WHERE lower(email) = lower($1))`,
        [opts.bootstrapEmail],
      );
      await c.query(
        `DELETE FROM zone_grants WHERE user_id IS NOT NULL AND user_id NOT IN
           (SELECT id FROM users WHERE lower(email) = lower($1))`,
        [opts.bootstrapEmail],
      );
      // 4. Delete every user except the bootstrap.
      await c.query(`DELETE FROM users WHERE lower(email) <> lower($1)`, [opts.bootstrapEmail]);
      // 5. The seed creates the bootstrap admin with must_change_password=true.
      //    Route handlers now enforce that flag (the compliance gate in
      //    requireUser), so the canonical "do everything" actor must be in a
      //    compliant state - model an admin who has completed first-login.
      await c.query(
        `UPDATE users SET must_change_password = false WHERE lower(email) = lower($1)`,
        [opts.bootstrapEmail],
      );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}
