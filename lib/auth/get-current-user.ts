/**
 * lib/auth/get-current-user.ts
 *
 * The dual-mode credential parser. Returns the authenticated `User` (and
 * their CASL ability) for the current request, or null if unauthenticated.
 *
 * Order of precedence:
 *   1. Session cookie (browser-side path)
 *   2. Bearer / X-API-Key token (machine path)
 *
 * Only the first matching credential is honored. Mixing would invite
 * "cookie says user A but token says user B" ambiguity.
 */

import "server-only";
import { headers } from "next/headers";
import {
  findApiTokenByPublicPrefix,
  touchApiTokenLastUsed,
} from "@/lib/db/repositories/api-tokens";
import { findUserById } from "@/lib/db/repositories/users";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { listGrantsForUser } from "@/lib/db/repositories/zone-grants";
import type { User } from "@/lib/db/schema";
import type { ZoneGrant } from "@/lib/db/schema";
import {
  buildAbility,
  globalPermissionsOf,
  type AbilitySource,
  type AppAbility,
} from "@/lib/rbac/ability";
import { getClientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { readSession } from "./session";
import { parsePresentedToken, verifyTokenAgainstHash } from "./tokens";
import { narrowAssignmentsByTokenScopes, type NarrowableAssignment } from "./token-scope-narrowing";

export interface AuthenticatedRequest {
  user: User;
  ability: AppAbility;
  /**
   * Permissions held at **global** scope. This — NOT a type-level
   * `ability.can(action, "Type")` — is the correct "can act on any
   * resource of this type" decision: a type-level CASL check returns
   * true even for a team/zone/server-scoped rule (see
   * `globalPermissionsOf`). Zone/record/dnssec/metadata routes combine
   * this with a per-zone `zone_grants` lookup via `canActOnZone`.
   */
  globalPermissions: ReadonlySet<string>;
  /**
   * Per-zone grants the user holds. Routes that mutate a specific
   * zone consult `canActOnZone` (`lib/rbac/zone-permissions`), which
   * allows the action when EITHER a global permission OR a matching
   * `zone_grants` row covers it.
   *
   * Token-auth callers see this narrowed to the same intersection
   * with `tokenRow.scopes` that `narrowAssignmentsByTokenScopes`
   * applies to role assignments — a leaked token can't grant a
   * permission the user lost.
   */
  zoneGrants: readonly ZoneGrant[];
  source: "session" | "token";
}

/**
 * Resolve the current actor. Returns null when no valid credential is
 * present. Throws for *malformed* credentials (e.g. a session cookie that
 * decrypts cleanly but points at a deleted user — that's an inconsistency,
 * not "anonymous").
 */
export async function getCurrentUser(): Promise<AuthenticatedRequest | null> {
  // --- Session cookie path -------------------------------------------------
  const session = await readSession();
  if (session) {
    const user = await findUserById(session.userId);
    if (!user) return null;
    if (user.disabledAt) return null;

    const [assignments, zoneGrants] = await Promise.all([
      loadUserAssignmentsForAbility(user.id),
      listGrantsForUser(user.id),
    ]);
    // Cast: the DB column is structurally `string[]` to avoid the
    // `lib/db → lib/rbac` import dependency, but values are written
    // by validated admin routes so they're guaranteed to be valid
    // `Permission` strings at this read.
    const sources = assignments as readonly AbilitySource[];
    const ability = buildAbility(sources);

    return {
      user,
      ability,
      globalPermissions: globalPermissionsOf(sources),
      zoneGrants,
      source: "session",
    };
  }

  // --- Bearer / X-API-Key path ---------------------------------------------
  // Accept `Authorization: Bearer pda_pat_<...>` or
  // `X-API-Key: pda_pat_<...>`. Both shapes carry the same opaque token.
  const hdrs = await headers();
  const presented = extractPresentedToken(hdrs);
  if (!presented) return null;

  return resolvePresentedToken(presented, getClientIp(hdrs));
}

function extractPresentedToken(hdrs: Headers): string | null {
  const auth = hdrs.get("authorization");
  if (auth) {
    // Case-insensitive "Bearer "; tolerate extra whitespace.
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const apiKey = hdrs.get("x-api-key");
  if (apiKey) return apiKey.trim();
  return null;
}

async function resolvePresentedToken(
  presented: string,
  ip: string | null,
): Promise<AuthenticatedRequest | null> {
  const parsed = parsePresentedToken(presented);
  if (!parsed) return null;

  const row = await findApiTokenByPublicPrefix(parsed.prefix);
  if (!row) return null;

  // Cheap structural rejections before the expensive Argon2 verify so
  // attackers can't use an Argon2 oracle to enumerate row presence.
  // Argon2 fires *after* prefix lookup so the timing of "no row" vs
  // "row but wrong" is similar at the slow scale — a missing-row caller
  // pays one DB round-trip; a present-row caller pays one DB + Argon2.
  // We accept that minor asymmetry because prefix space (2^48) makes
  // enumeration impractical regardless.
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const matched = await verifyTokenAgainstHash(presented, row.tokenHash);
  if (!matched) return null;

  const user = await findUserById(row.userId);
  if (!user) return null;
  if (user.disabledAt) return null;

  const [rawAssignments, rawGrants] = await Promise.all([
    loadUserAssignmentsForAbility(user.id),
    listGrantsForUser(user.id),
  ]);
  const narrowed = narrowAssignmentsByTokenScopes(
    rawAssignments as readonly NarrowableAssignment[],
    row.scopes,
  );
  // Same cast rationale as the session path — DB column is structurally
  // string[] but values are validated at write time.
  const sources = narrowed as readonly AbilitySource[];
  const ability = buildAbility(sources);

  // Narrow grants by the token's scope set too — a leaked token can't
  // exercise a permission the user has via a zone grant if the token
  // wasn't issued with that permission. Empty token scopes preserve
  // the user's full grants (back-compat with pre-scope tokens).
  const zoneGrants =
    row.scopes.length === 0
      ? rawGrants
      : rawGrants
          .map((g) => ({
            ...g,
            permissions: g.permissions.filter((p) => row.scopes.includes(p)),
          }))
          .filter((g) => g.permissions.length > 0);

  // Opportunistically bump lastUsedAt + lastUsedIp. Fire-and-forget so a
  // write failure (transient DB hiccup, replica lag, anything) doesn't
  // block the request — auth already succeeded.
  void touchApiTokenLastUsed(row.id, ip).catch((cause) => {
    logger.warn(
      { tokenId: row.id, err: cause instanceof Error ? cause.message : "unknown" },
      "auth.token.touch.failed",
    );
  });

  return {
    user,
    ability,
    globalPermissions: globalPermissionsOf(sources),
    zoneGrants,
    source: "token",
  };
}
