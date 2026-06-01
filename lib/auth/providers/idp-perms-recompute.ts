/**
 * lib/auth/providers/idp-perms-recompute.ts
 *
 * The orchestrator the token-auth path calls to live-recompute
 * IdP-derived permissions at API token use time.
 *
 * Strategy per protocol:
 *   - **LDAP** - service-account bind + search via
 *     `fetchLdapGroupsForUser`. The user's username is their email
 *     (the same value the sign-in route searches by); the email lives
 *     on `users.email`.
 *   - **OIDC** - refresh-token → userinfo via
 *     `fetchOidcGroupsForUser`. Refresh token lives encrypted on the
 *     session row (the user's most recent OIDC sign-in).
 *   - **SAML** - no back-channel; caller stays on the session
 *     snapshot per `TOKEN_IDP_FALLBACK_TTL_SECONDS`. This module
 *     doesn't handle SAML.
 *
 * Result is materialised into `AbilitySource[]` via the shared pure
 * `computeGroupSync` (so role-slug resolution + permission inlining
 * is identical to sign-in), cached in `idp-perms-cache.ts`, and
 * returned. The next call within `IDP_PERMS_CACHE_TTL_SECONDS` reads
 * the cache; after that, a fresh live call runs.
 *
 * On ANY failure (IdP unreachable, refresh rejected, search fails),
 * returns `null` so the caller falls back to the session-snapshot
 * path bounded by the existing 24h TTL. The token doesn't lose IdP
 * perms instantly on a transient IdP blip.
 */

import "server-only";
import { appendAudit } from "@/lib/audit/log";
import { decrypt } from "@/lib/crypto/encryption";
import { findOidcProviderBySlug } from "@/lib/db/repositories/oidc-providers";
import { findLdapProviderBySlug } from "@/lib/db/repositories/ldap-providers";
import { logger } from "@/lib/logger";
import type { AbilitySource } from "@/lib/rbac/ability";
import { computeGroupSync } from "./group-sync";
import { fetchLdapGroupsForUser } from "./ldap";
import { fetchOidcGroupsForUser } from "./oidc";
import { getIdpPerms, putIdpPerms } from "./idp-perms-cache";

interface RecomputeInput {
  userId: string;
  /** User's email - the username we search for in LDAP. */
  userEmail: string;
  providerType: "oidc" | "saml" | "ldap";
  providerSlug: string;
  /** Encrypted refresh token from the session row. Only set for OIDC. */
  oidcRefreshTokenEncrypted: string | null;
}

/**
 * Compute live IdP-derived `AbilitySource[]`. Returns `null` to signal
 * "couldn't recompute; fall back to the session snapshot." Returns an
 * empty array (NOT null) when the recompute succeeded but no group
 * mappings matched - that's a valid "you have no IdP-derived perms
 * right now" answer, not a failure.
 */
export async function recomputeIdpPermissions(
  input: RecomputeInput,
): Promise<readonly AbilitySource[] | null> {
  // SAML has no back-channel - fall back to the session-snapshot path.
  if (input.providerType === "saml") return null;

  const cached = getIdpPerms(input.userId, input.providerType, input.providerSlug);
  if (cached !== null) return cached;

  let groupsClaim: unknown;
  let mappings;

  if (input.providerType === "ldap") {
    const [groups, providerRow] = await Promise.all([
      fetchLdapGroupsForUser(input.providerSlug, input.userEmail),
      findLdapProviderBySlug(input.providerSlug),
    ]);
    if (groups === null || !providerRow) return null;
    groupsClaim = groups;
    mappings = providerRow.groupMappings;
  } else {
    // OIDC.
    if (!input.oidcRefreshTokenEncrypted) {
      // No refresh token (the IdP didn't include offline_access, or
      // an older session pre-dates the column). Fall back.
      return null;
    }
    let refreshToken: string;
    try {
      refreshToken = decrypt(input.oidcRefreshTokenEncrypted, "oidc-refresh-token");
    } catch (err) {
      logger.warn(
        {
          provider: input.providerSlug,
          err: err instanceof Error ? err.message : "unknown",
        },
        "oidc.recompute.refresh-decrypt-failed",
      );
      return null;
    }
    const [groups, providerRow] = await Promise.all([
      fetchOidcGroupsForUser(input.providerSlug, refreshToken),
      findOidcProviderBySlug(input.providerSlug),
    ]);
    if (groups === null || !providerRow) return null;
    groupsClaim = groups;
    mappings = providerRow.groupMappings;
  }

  const { derived } = await computeGroupSync({
    groupsClaim,
    mappings: mappings ?? null,
  });

  putIdpPerms(input.userId, input.providerType, input.providerSlug, derived);

  // Audit one row per cache window (throttling lives in the cache -
  // every cache miss writes one row; cache hits don't).
  void appendAudit({
    actor: { type: "system", id: null },
    action: "auth.token.idp_perms_refreshed",
    resource: { type: "user", id: input.userId },
    after: {
      provider: input.providerSlug,
      providerType: input.providerType,
      sourceCount: derived.length,
    },
    request: undefined,
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "auth.token.idp_perms_refreshed.audit-failed",
    );
  });

  return derived;
}
