/**
 * lib/db/repositories/sessions.ts
 *
 * Server-side session row CRUD. ADR 0007 explains why these rows exist.
 *
 * The session ID is opaque — clients see only an encrypted form. The "key"
 * a route handler authenticates with is the decrypted session-row UUID, which
 * we then load and validate here.
 */

import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { countStar } from "@/lib/db/sql-dialect";
import { sessions, type NewSession, type Session } from "@/lib/db/schema";

/** Create a new session row. Returns the persisted row including its id. */
export async function createSession(input: NewSession): Promise<Session> {
  const rows = await db.insert(sessions).values(input).returning();
  if (!rows[0]) throw new Error("Session insert returned no row.");
  return rows[0];
}

/**
 * Fetch a session by id IF it is still valid (not expired). Returns null
 * otherwise. Side-effect-free; the caller updates `lastSeenAt` separately.
 */
export async function findValidSessionById(id: string): Promise<Session | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

/** Bump `lastSeenAt` on a session — call once per request. */
export async function touchSession(id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, id));
}

/** Delete a single session — used for logout. */
export async function revokeSession(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(sessions).where(eq(sessions.id, id));
}

/** Delete all sessions for a user — used for "log out everywhere". */
export async function revokeSessionsForUser(
  userId: string,
  executor: DbExecutor = db,
): Promise<number> {
  const result = await executor
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return result.length;
}

/**
 * Count active sessions app-wide — the metric sampler's source for the
 * dashboard "Active sessions" KPI + 7-day chart. "Active" == not expired;
 * revocation is a row DELETE (there is no revoked flag), so a present,
 * unexpired row is the whole definition — same predicate as
 * `listSessionsForUser`. The optional executor keeps this unit-testable
 * without a live DB, mirroring the write helpers above.
 */
export async function countActiveSessions(executor: DbExecutor = db): Promise<number> {
  const rows = await executor
    .select({ count: countStar() })
    .from(sessions)
    .where(gt(sessions.expiresAt, new Date()));
  return Number(rows[0]?.count ?? 0);
}

/** List a user's active sessions for the "your sessions" UI. */
export async function listSessionsForUser(userId: string): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
}

/**
 * Wipe every session in the table. Incident-response action — used
 * when the operator decides "everyone needs to re-authenticate"
 * (config leak, infrastructure compromise, suspected credential
 * dump). When `exceptSessionId` is passed, that one row is spared
 * so the operator running the action doesn't log themselves out and
 * lose the audit-log window mid-investigation. Returns the number
 * of rows deleted.
 */
export async function revokeAllSessions(
  exceptSessionId?: string,
  executor: DbExecutor = db,
): Promise<number> {
  const result = exceptSessionId
    ? await executor
        .delete(sessions)
        .where(sql`${sessions.id} <> ${exceptSessionId}`)
        .returning({ id: sessions.id })
    : await executor.delete(sessions).returning({ id: sessions.id });
  return result.length;
}
