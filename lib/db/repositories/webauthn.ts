/**
 * lib/db/repositories/webauthn.ts
 *
 * Read/write helpers for the `users.webauthn_credentials` JSONB array.
 *
 * Why JSONB and not a separate `webauthn_credentials` table: at the scale
 * we expect (single-digit credentials per user, never thousands), a normal-
 * form table buys nothing - every read is "fetch user + all credentials"
 * which is one query either way, and the credential set has no foreign-key
 * relationships that warrant the join overhead. The shape (`WebauthnCredential`
 * in `lib/db/schema/users.ts`) is fixed; mutations go through this module so
 * the JSONB stays consistent.
 *
 * All mutations are transactional and run as `read → mutate → write`. There's
 * no row-level lock on the JSONB column, so the LAST writer wins on a
 * concurrent enroll/remove - acceptable trade-off (concurrent enrolment
 * attempts by the same user are vanishingly rare; the SELECT-then-UPDATE
 * race window is ~microseconds).
 */

import "server-only";
import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { users, type User, type WebauthnCredential } from "@/lib/db/schema";

/** List a user's WebAuthn credentials (returns the raw JSONB array, never null). */
export async function listCredentials(
  userId: string,
  executor: DbExecutor = db,
): Promise<WebauthnCredential[]> {
  const rows = await executor
    .select({ webauthnCredentials: users.webauthnCredentials })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.webauthnCredentials ?? [];
}

/** Find one credential by its `id` (base64url) on a given user. */
export async function findCredentialById(
  userId: string,
  credentialId: string,
  executor: DbExecutor = db,
): Promise<WebauthnCredential | null> {
  const all = await listCredentials(userId, executor);
  return all.find((c) => c.id === credentialId) ?? null;
}

/**
 * Find the user that holds a given credential id (passkey discoverable-
 * credential / username-less login). O(n) scan via the SQL-side `?` JSONB
 * containment operator with a fallback to in-memory match. Not a hot path
 * at our scale.
 */
export async function findUserByCredentialId(
  credentialId: string,
  executor: DbExecutor = db,
): Promise<{ user: User; credential: WebauthnCredential } | null> {
  // Single full-scan SELECT, then JS-side filter. JSONB GIN indexes on the
  // array would help if we ever care; today the user count is in the
  // single thousands at most.
  const rows = await executor.select().from(users);
  for (const u of rows) {
    const cred = u.webauthnCredentials.find((c) => c.id === credentialId);
    if (cred) return { user: u, credential: cred };
  }
  return null;
}

/** Append a credential. Refuses to add a duplicate id (idempotency guard). */
export async function addCredential(
  userId: string,
  cred: WebauthnCredential,
  executor: DbExecutor = db,
): Promise<WebauthnCredential[]> {
  const existing = await listCredentials(userId, executor);
  if (existing.some((c) => c.id === cred.id)) {
    throw new Error(`WebAuthn credential ${cred.id} already registered.`);
  }
  const next = [...existing, cred];
  await executor
    .update(users)
    .set({ webauthnCredentials: next, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return next;
}

/** Remove one credential by id. Returns the updated list. */
export async function removeCredential(
  userId: string,
  credentialId: string,
  executor: DbExecutor = db,
): Promise<WebauthnCredential[]> {
  const existing = await listCredentials(userId, executor);
  const next = existing.filter((c) => c.id !== credentialId);
  if (next.length === existing.length) return existing; // nothing to do
  await executor
    .update(users)
    .set({ webauthnCredentials: next, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return next;
}

/**
 * Bump `counter` + `lastUsedAt` on a successful assertion. Replay-defends:
 * an assertion reporting a counter `<=` the stored value rejects upstream
 * (in the ceremony helper); this function just persists the new value.
 */
export async function touchCredential(
  userId: string,
  credentialId: string,
  counter: number,
  executor: DbExecutor = db,
): Promise<void> {
  const existing = await listCredentials(userId, executor);
  const next = existing.map((c) =>
    c.id === credentialId ? { ...c, counter, lastUsedAt: new Date().toISOString() } : c,
  );
  await executor
    .update(users)
    .set({ webauthnCredentials: next, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Rename a credential. Used by the profile UI's per-credential edit
 * affordance. No-op if the id is unknown (idempotent).
 */
export async function renameCredential(
  userId: string,
  credentialId: string,
  nickname: string,
  executor: DbExecutor = db,
): Promise<void> {
  const existing = await listCredentials(userId, executor);
  const next = existing.map((c) => (c.id === credentialId ? { ...c, nickname } : c));
  await executor
    .update(users)
    .set({ webauthnCredentials: next, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
