/**
 * lib/db/repositories/users.ts
 *
 * Query functions over the `users` table. Pure data access - no business
 * rules, no authorization. Callers (auth providers, admin route handlers)
 * own those decisions.
 *
 * Why repositories instead of inlining Drizzle queries everywhere:
 *  - Single search target for "everywhere we touch users" when the schema
 *    evolves or a column gets renamed.
 *  - Easy to mock in tests.
 *  - Keeps query patterns consistent (e.g., everyone lowercases email the
 *    same way for lookups).
 */

import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { users, type NewUser, type User } from "@/lib/db/schema";

/** Find a user by their email (case-insensitive). */
export async function findUserByEmail(email: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

/** Find a user by id. */
export async function findUserById(id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Insert a new user. The caller is responsible for hashing the password (if any). */
export async function insertUser(input: NewUser, executor: DbExecutor = db): Promise<User> {
  const rows = await executor.insert(users).values(input).returning();
  if (!rows[0]) throw new Error("Insert returned no row.");
  return rows[0];
}

/** Update mutable fields on a user. Returns the new row. */
export async function updateUser(
  id: string,
  patch: Partial<Omit<User, "id" | "createdAt">>,
  executor: DbExecutor = db,
): Promise<User | null> {
  // Whenever the password hash rotates, bump passwordHashUpdatedAt. The
  // single-use guarantee for reset / email-verification tokens keys off this
  // timestamp; if it isn't bumped on the self-service change-password and
  // admin reset-password paths (both of which write the hash via this
  // function), an outstanding reset link stays redeemable after the password
  // already changed.
  const bump = patch.passwordHash !== undefined ? { passwordHashUpdatedAt: new Date() } : {};
  const rows = await executor
    .update(users)
    .set({ ...patch, ...bump, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Update only the last-login fields after a successful sign-in. */
export async function recordSuccessfulLogin(id: string, ip: string | null): Promise<void> {
  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      lastLoginIp: ip,
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
}

/**
 * Decide the lockout deadline for a given (post-increment) failed-login count.
 *
 * Pure so the threshold→lockedUntil rule can be unit-tested without a database.
 * Returns `null` when the count is still below the threshold (no lock yet).
 *
 * @param failedCount the failed-login count AFTER this attempt was recorded.
 * @param threshold   number of failures at which the account locks (≥ this locks).
 * @param lockoutSeconds how long the lock lasts from `now`.
 */
export function computeLockoutUntil(
  failedCount: number,
  threshold: number,
  lockoutSeconds: number,
  now: Date = new Date(),
): Date | null {
  return failedCount >= threshold ? new Date(now.getTime() + lockoutSeconds * 1000) : null;
}

/**
 * Increment the failed-login counter and, if the threshold is hit, set a
 * `lockedUntil` timestamp. Returns the new failed count for the caller's log.
 *
 * The increment is performed atomically in the database
 * (`failed_login_count = failed_login_count + 1`) and read back via
 * `.returning()`. Computing the next value in JS from a prior `SELECT` (the
 * old read-modify-write) let two concurrent failed logins both read N and
 * write N+1, losing an increment and letting an attacker exceed the lockout
 * threshold (GHSA-frpq-xgm7-574x). The atomic statement makes every concurrent
 * failure count exactly once.
 *
 * Both Postgres and SQLite support the `sql` increment template and
 * `.returning()` via Drizzle. The follow-up lock write is keyed on the
 * returned count, so it only runs once the threshold is genuinely crossed; it
 * is idempotent (concurrent failures past the threshold all set a correct
 * lock window).
 */
export async function recordFailedLogin(
  id: string,
  threshold: number,
  lockoutSeconds: number,
): Promise<{ failedCount: number; lockedUntil: Date | null }> {
  const incremented = await db
    .update(users)
    .set({
      failedLoginCount: sql`${users.failedLoginCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning({ failedCount: users.failedLoginCount });

  const row = incremented[0];
  if (!row) return { failedCount: 0, lockedUntil: null };

  const lockedUntil = computeLockoutUntil(row.failedCount, threshold, lockoutSeconds);
  if (lockedUntil) {
    await db.update(users).set({ lockedUntil }).where(eq(users.id, id));
  }

  return { failedCount: row.failedCount, lockedUntil };
}

/** True if a user is currently locked out. */
export function isLockedOut(user: User, now: Date = new Date()): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
}

/** Has the user been disabled by an admin? */
export function isDisabled(user: User): boolean {
  return user.disabledAt !== null;
}

/**
 * List every user (including disabled), newest-first. Used by the admin
 * users page where the operator needs to see and act on disabled accounts.
 */
export async function listAllUsers(limit = 100, offset = 0): Promise<User[]> {
  return db
    .select()
    .from(users)
    .orderBy(sql`${users.createdAt} DESC`)
    .limit(limit)
    .offset(offset);
}

/** Hard-delete a user. Cascades to sessions, role assignments, etc. */
export async function deleteUserById(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(users).where(eq(users.id, id));
}
