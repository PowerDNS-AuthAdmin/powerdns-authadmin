/**
 * lib/db/repositories/roles.last-super-admin.test.ts
 *
 * Regression unit tests for the last-SuperAdmin count query
 * (`countGlobalAssignmentsOfRoleSlug`) — the data-layer half of
 * GHSA-86v6-w5p9-29r8. The route guards that consume it are covered over HTTP
 * by tests/integration/admin/role-assignments.test.ts (a real DB invariant),
 * but the query's *logic* — exclude disabled users, dedupe a user with two
 * global rows — is exercised here directly so a regression fails the fast unit
 * suite, not just the gated integration suite.
 *
 * Runs against an in-memory SQLite database, which proves the query is
 * dialect-portable (`count(distinct …)`, `isNull`, inner joins). This test file
 * REQUIRES `DATABASE_URL` to be a `file:`/`sqlite:` URL so the module graph
 * resolves to the SQLite dialect; the runner sets it. When it isn't SQLite, the
 * suite skips with a loud message rather than silently passing.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isSqlite } from "@/lib/db/_dialect";
// Type-only imports are erased at compile time, so they don't construct the
// (Postgres) connection that the runtime `lib/db` module builds eagerly — that
// stays lazily imported below, inside the SQLite-gated suite.
import type { closeDatabase, db, sqliteHandle } from "@/lib/db";
import type { roleAssignments, roles, users } from "@/lib/db/schema";
import type { countGlobalAssignmentsOfRoleSlug, userHoldsGlobalRoleSlug } from "./roles";

const describeSqlite = isSqlite ? describe : describe.skip;

if (!isSqlite) {
  console.warn(
    "[roles.last-super-admin.test] SKIPPED: needs a SQLite DATABASE_URL " +
      "(file:…/sqlite:…). Run via the dedicated unit-sqlite script.",
  );
}

describeSqlite("countGlobalAssignmentsOfRoleSlug (last-SuperAdmin guard query)", () => {
  // Bound lazily in beforeEach so the SKIP path doesn't pull in the server-only
  // DB module under a Postgres URL (which would try to construct a pg pool at
  // import). The types above are erased, so they cost nothing at runtime.
  let dbInstance: typeof db;
  let sqliteHandleFn: typeof sqliteHandle;
  let closeDatabaseFn: typeof closeDatabase;
  let countFn: typeof countGlobalAssignmentsOfRoleSlug;
  let holdsFn: typeof userHoldsGlobalRoleSlug;
  let usersTable: typeof users;
  let rolesTable: typeof roles;
  let roleAssignmentsTable: typeof roleAssignments;

  const SUPER_ADMIN_SLUG = "super-admin";

  function createSchema(): void {
    const handle = sqliteHandleFn();
    if (!handle) throw new Error("expected a SQLite handle in SQLite mode");
    handle.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        image_url TEXT,
        password_hash TEXT,
        totp_secret_encrypted TEXT,
        mfa_required INTEGER,
        webauthn_credentials TEXT NOT NULL DEFAULT '[]',
        email_verified_at INTEGER,
        locked_until INTEGER,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        disabled_at INTEGER,
        last_login_at INTEGER,
        last_login_ip TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        password_hash_updated_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        requires_mfa INTEGER NOT NULL DEFAULT 0,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS role_assignments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        created_by TEXT,
        provider_id TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  function truncate(): void {
    const handle = sqliteHandleFn();
    if (!handle) throw new Error("expected a SQLite handle in SQLite mode");
    handle.exec("DELETE FROM role_assignments; DELETE FROM users; DELETE FROM roles;");
  }

  async function seedRole(): Promise<string> {
    const id = "role-super";
    await dbInstance
      .insert(rolesTable)
      .values({ id, slug: SUPER_ADMIN_SLUG, name: "Super Admin", isSystem: true });
    return id;
  }

  async function seedUser(id: string, disabled: boolean): Promise<void> {
    await dbInstance.insert(usersTable).values({
      id,
      email: `${id}@test.local`,
      disabledAt: disabled ? new Date() : null,
    });
  }

  async function assignGlobal(id: string, userId: string, roleId: string): Promise<void> {
    await dbInstance
      .insert(roleAssignmentsTable)
      .values({ id, userId, roleId, scopeType: "global", scopeId: null });
  }

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    dbInstance = dbModule.db;
    sqliteHandleFn = dbModule.sqliteHandle;
    closeDatabaseFn = dbModule.closeDatabase;
    const schema = await import("@/lib/db/schema");
    usersTable = schema.users;
    rolesTable = schema.roles;
    roleAssignmentsTable = schema.roleAssignments;
    const repo = await import("./roles");
    countFn = repo.countGlobalAssignmentsOfRoleSlug;
    holdsFn = repo.userHoldsGlobalRoleSlug;
    createSchema();
    truncate();
  });

  afterAll(async () => {
    await closeDatabaseFn();
  });

  it("counts one enabled global Super Admin", async () => {
    const roleId = await seedRole();
    await seedUser("u1", false);
    await assignGlobal("a1", "u1", roleId);

    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(1);
  });

  it("excludes a DISABLED Super Admin from the count", async () => {
    const roleId = await seedRole();
    await seedUser("u1", false); // enabled
    await seedUser("u2", true); // disabled — must NOT count
    await assignGlobal("a1", "u1", roleId);
    await assignGlobal("a2", "u2", roleId);

    // The old `rows.length` query returned 2 here, wrongly treating the disabled
    // account as a live admin and letting the last *usable* one be removed.
    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(1);
  });

  it("dedupes a user holding two global Super Admin rows", async () => {
    const roleId = await seedRole();
    await seedUser("u1", false);
    // Two distinct assignment rows for the SAME user at global scope.
    await assignGlobal("a1", "u1", roleId);
    await assignGlobal("a2", "u1", roleId);

    // The old query counted rows (2). DISTINCT user_id collapses this to 1, so
    // a single-admin install can't be tricked into thinking it has two.
    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(1);
  });

  it("returns 0 when the only Super Admin is disabled (lockout boundary)", async () => {
    const roleId = await seedRole();
    await seedUser("u1", true);
    await assignGlobal("a1", "u1", roleId);

    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(0);
  });

  it("counts two distinct enabled Super Admins", async () => {
    const roleId = await seedRole();
    await seedUser("u1", false);
    await seedUser("u2", false);
    await assignGlobal("a1", "u1", roleId);
    await assignGlobal("a2", "u2", roleId);

    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(2);
  });

  it("ignores non-global Super Admin assignments", async () => {
    const roleId = await seedRole();
    await seedUser("u1", false);
    // Team-scoped assignment — not a global Super Admin, so it doesn't count.
    await dbInstance
      .insert(roleAssignmentsTable)
      .values({ id: "a1", userId: "u1", roleId, scopeType: "team", scopeId: "team-1" });

    expect(await countFn(SUPER_ADMIN_SLUG)).toBe(0);
  });

  describe("userHoldsGlobalRoleSlug", () => {
    it("is true for a user with a global Super Admin assignment, regardless of enabled state", async () => {
      const roleId = await seedRole();
      await seedUser("u1", true); // even disabled, they HOLD the role
      await assignGlobal("a1", "u1", roleId);

      expect(await holdsFn("u1", SUPER_ADMIN_SLUG)).toBe(true);
    });

    it("is false for a user holding the role only at a non-global scope", async () => {
      const roleId = await seedRole();
      await seedUser("u1", false);
      await dbInstance
        .insert(roleAssignmentsTable)
        .values({ id: "a1", userId: "u1", roleId, scopeType: "team", scopeId: "team-1" });

      expect(await holdsFn("u1", SUPER_ADMIN_SLUG)).toBe(false);
    });

    it("is false for a user with no assignment of the role", async () => {
      await seedRole();
      await seedUser("u1", false);

      expect(await holdsFn("u1", SUPER_ADMIN_SLUG)).toBe(false);
    });
  });
});
