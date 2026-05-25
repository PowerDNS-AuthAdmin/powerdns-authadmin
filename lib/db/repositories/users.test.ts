/**
 * lib/db/repositories/users.test.ts
 *
 * Regression coverage for the failed-login lockout path (GHSA-frpq-xgm7-574x).
 *
 * Two layers:
 *  - `computeLockoutUntil` — the pure threshold→lockedUntil rule, no DB.
 *  - `recordFailedLogin` — the atomic increment, exercised against a real
 *    on-disk SQLite database (one of the two supported dialects). The
 *    pre-fix read-modify-write lost increments under concurrency; the
 *    concurrency case below is the regression that would fail before the fix.
 *
 * SQLite is used here because it gives a hermetic, no-Docker DB. The same
 * repository code runs on Postgres in CI's integration suite; the `sql`
 * increment template and `.returning()` are portable across both dialects.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { computeLockoutUntil } from "./users";
import type * as UsersRepository from "./users";

/**
 * `better-sqlite3` is a native addon: it only loads when its prebuilt binary
 * matches the running Node ABI (NODE_MODULE_VERSION). When it doesn't (e.g. a
 * dev machine whose Node differs from the one node_modules was built against),
 * opening a DB throws `ERR_DLOPEN_FAILED`. We probe once here and skip the
 * DB-backed suite rather than fail the run — CI builds the addon for its Node,
 * so the suite (incl. the concurrency regression) runs there.
 */
function sqliteAddonLoads(): boolean {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
}
const describeDb = sqliteAddonLoads() ? describe : describe.skip;

describe("computeLockoutUntil", () => {
  const now = new Date("2026-05-24T12:00:00.000Z");

  it("returns null below the threshold", () => {
    expect(computeLockoutUntil(1, 10, 900, now)).toBeNull();
    expect(computeLockoutUntil(9, 10, 900, now)).toBeNull();
  });

  it("locks exactly at the threshold", () => {
    const until = computeLockoutUntil(10, 10, 900, now);
    expect(until).not.toBeNull();
    // 900s = 15 minutes from `now`.
    expect(until!.getTime()).toBe(now.getTime() + 900 * 1000);
  });

  it("stays locked past the threshold", () => {
    const until = computeLockoutUntil(11, 10, 900, now);
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBe(now.getTime() + 900 * 1000);
  });
});

describeDb("recordFailedLogin (SQLite, atomic increment)", () => {
  let tempDir: string;
  let dbFile: string;
  // Loaded after DATABASE_URL is pointed at the temp SQLite file so the
  // repository's `db` singleton binds to it.
  let repo: typeof UsersRepository;
  let rawDb: ReturnType<typeof drizzle>;
  let handle: Database.Database;

  const THRESHOLD = 5;
  const LOCKOUT_SECONDS = 900;

  function insertTestUser(email: string): string {
    const id = crypto.randomUUID();
    const nowMs = Date.now();
    handle
      .prepare(
        `INSERT INTO users (id, email, failed_login_count, password_hash_updated_at, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(id, email, nowMs, nowMs, nowMs);
    return id;
  }

  function readUser(id: string): { failed_login_count: number; locked_until: number | null } {
    return handle
      .prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?")
      .get(id) as { failed_login_count: number; locked_until: number | null };
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pda-users-test-"));
    dbFile = join(tempDir, "test.db");

    // Build the schema with the same migrations the app ships for SQLite.
    handle = new Database(dbFile);
    handle.pragma("foreign_keys = ON");
    rawDb = drizzle(handle);
    migrate(rawDb, { migrationsFolder: "drizzle-sqlite" });

    // Point the repository's db singleton at this file, then import it.
    process.env["DATABASE_URL"] = `file:${dbFile}`;
    repo = await import("./users");
  });

  afterAll(() => {
    handle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("increments the counter and does not lock below the threshold", async () => {
    const id = insertTestUser("below@example.com");

    const result = await repo.recordFailedLogin(id, THRESHOLD, LOCKOUT_SECONDS);

    expect(result.failedCount).toBe(1);
    expect(result.lockedUntil).toBeNull();

    const row = readUser(id);
    expect(row.failed_login_count).toBe(1);
    expect(row.locked_until).toBeNull();
  });

  it("sets lockedUntil once the threshold is reached", async () => {
    const id = insertTestUser("reaches@example.com");

    let last: Awaited<ReturnType<typeof repo.recordFailedLogin>> | undefined;
    for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
      last = await repo.recordFailedLogin(id, THRESHOLD, LOCKOUT_SECONDS);
    }

    expect(last!.failedCount).toBe(THRESHOLD);
    expect(last!.lockedUntil).not.toBeNull();

    const row = readUser(id);
    expect(row.failed_login_count).toBe(THRESHOLD);
    expect(row.locked_until).not.toBeNull();
  });

  it("returns a zeroed result for an unknown user (no row updated)", async () => {
    const result = await repo.recordFailedLogin(crypto.randomUUID(), THRESHOLD, LOCKOUT_SECONDS);
    expect(result.failedCount).toBe(0);
    expect(result.lockedUntil).toBeNull();
  });

  it("does not lose increments under concurrent failed logins", async () => {
    const id = insertTestUser("concurrent@example.com");

    // Fire many failed-login records at once. With the pre-fix
    // read-modify-write, concurrent calls would each read N and write N+1,
    // so the final count would be far below CONCURRENT. The atomic
    // UPDATE ... SET x = x + 1 guarantees every call counts exactly once.
    const CONCURRENT = 50;
    await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        repo.recordFailedLogin(id, THRESHOLD, LOCKOUT_SECONDS),
      ),
    );

    const row = readUser(id);
    expect(row.failed_login_count).toBe(CONCURRENT);
    // Far past the threshold → account must be locked.
    expect(row.locked_until).not.toBeNull();
  });
});
