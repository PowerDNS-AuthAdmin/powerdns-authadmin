/**
 * lib/db/repositories/api-tokens.ts
 *
 * Server-side CRUD for personal access tokens. The presentation flow
 * (`Authorization: Bearer pda_pat_<...>` or `X-API-Key: pda_pat_<...>`)
 * looks up by the 8-char public prefix here, then verifies the Argon2
 * hash + scope intersection in `lib/auth/get-current-user.ts`.
 *
 * Mutations (issue / revoke) live in their own admin route handlers
 * which use the broader Drizzle plumbing directly — this repo only
 * exposes the read path + the side-effect of bumping `lastUsedAt`.
 */

import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { apiTokens, type ApiToken, type NewApiToken } from "@/lib/db/schema";

/**
 * Look up a token row by its public prefix. Returns null when nothing
 * matches. The prefix column is uniquely indexed so this is a single
 * b-tree probe.
 */
export async function findApiTokenByPublicPrefix(prefix: string): Promise<ApiToken | null> {
  // Cheap guard against pathological inputs — the prefix shape is fixed
  // by `lib/auth/tokens.ts` (8 base64url chars). Anything else can't
  // match, so don't bother hitting the DB.
  if (prefix.length === 0 || prefix.length > 64) return null;
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.prefix, prefix)).limit(1);
  return rows[0] ?? null;
}

/**
 * Bump `lastUsedAt` and `lastUsedIp` for an accepted token. Called
 * fire-and-forget from the auth path — failure here must not break the
 * request, so the caller swallows errors and logs them at warn level.
 */
export async function touchApiTokenLastUsed(id: string, ip: string | null): Promise<void> {
  await db
    .update(apiTokens)
    .set({
      lastUsedAt: new Date(),
      lastUsedIp: ip,
      updatedAt: new Date(),
    })
    .where(eq(apiTokens.id, id));
}

/**
 * List every token owned by a user, newest first, INCLUDING revoked
 * rows. The UI hides revoked tokens after a grace period so the
 * operator can see "what did I revoke?" briefly without keeping the
 * table cluttered indefinitely.
 *
 * Returns ApiToken rows verbatim — the route layer is responsible for
 * stripping `tokenHash` before serializing to the client.
 */
export async function listApiTokensForUser(userId: string): Promise<ApiToken[]> {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

/**
 * Insert a freshly-minted token row. Caller has already generated the
 * prefix + Argon2 hash via `lib/auth/tokens.ts`; this is a plain
 * pass-through.
 */
export async function insertApiToken(
  input: NewApiToken,
  executor: DbExecutor = db,
): Promise<ApiToken> {
  const rows = await executor.insert(apiTokens).values(input).returning();
  if (!rows[0]) throw new Error("API token insert returned no row.");
  return rows[0];
}

/**
 * Mark a token as revoked. Soft-delete: we keep the row for audit
 * correlation. Re-revoking is idempotent (no-op if already revoked).
 * Returns the updated row when one matched; null when no token with
 * that id exists for the user.
 */
export async function revokeApiToken(
  input: {
    id: string;
    userId: string;
  },
  executor: DbExecutor = db,
): Promise<ApiToken | null> {
  const rows = await executor
    .update(apiTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(apiTokens.id, input.id), eq(apiTokens.userId, input.userId)))
    .returning();
  return rows[0] ?? null;
}
