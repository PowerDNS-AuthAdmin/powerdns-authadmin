/**
 * lib/db/schema/sessions.ts
 *
 * Server-side session store. ADR 0007 explains why DB-backed instead of JWT.
 *
 * The cookie carries the *encrypted* form of the row's `id` value. On every
 * request we decrypt the cookie, look the row up by id, verify it isn't
 * expired or revoked, and attach the row's user to the request context.
 *
 * `csrf_secret` is the server-side half of double-submit CSRF protection; the
 * client side is a separate cookie (not encrypted) and a header on
 * state-changing requests must match a HMAC of the secret.
 */

import { index, inet, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    // Last-used timestamp updated by the session middleware on every request.
    // Indexed for the "recently active sessions" admin view.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    // Provenance — useful for the user's "manage sessions" view and for
    // anomaly detection (geo / UA suddenly changing).
    ip: inet("ip"),
    userAgent: text("user_agent"),

    // 32 random bytes, base64url-encoded. Never exposed to the client; only
    // HMACs of it are.
    csrfSecret: text("csrf_secret").notNull(),

    // RP-initiated-logout (OIDC Session Management). When the session
    // was minted via OIDC AND the IdP advertised an
    // end_session_endpoint at discovery time, we stash both the URL
    // and the original id_token here so /api/auth/logout can build
    // the redirect to the IdP's signed-out screen
    // (`<end_session_url>?id_token_hint=<id_token>&client_id=<id>`).
    // Both null for local-source sessions — logout falls back to the
    // plain cookie-clear path.
    oidcEndSessionUrl: text("oidc_end_session_url"),
    oidcIdToken: text("oidc_id_token"),
    oidcClientId: text("oidc_client_id"),

    /**
     * Per-session snapshot of permissions derived from the user's IdP
     * groups at sign-in. The ability builder folds these into the user's
     * effective set alongside admin-issued `role_assignments`.
     *
     * Why on the session and not on the user: IdP group membership is
     * ephemeral. Persisting derived rows on the user leaves stale grants
     * for users who never sign in again. Sessions naturally expire; this
     * column does too.
     *
     * Empty array for local-auth sessions (and for IdP sessions with no
     * configured `group_mappings`). Shape matches `AbilitySource` from
     * `lib/rbac/ability.ts`: `{ permissions, scopeType, scopeId }`.
     */
    derivedPermissions: jsonb("derived_permissions")
      .$type<
        Array<{
          permissions: readonly string[];
          scopeType: "global" | "team" | "zone" | "server";
          scopeId: string | null;
        }>
      >()
      .notNull()
      .default([]),

    /**
     * Encrypted OIDC refresh token (AES-256-GCM via
     * `lib/crypto/encryption.ts`). Populated only when the OIDC sign-in
     * returned a refresh token. Used by the token-auth path to re-fetch
     * the user's groups claim at API-token use time — the basis for
     * "tokens follow real permissions" semantics. Null for local / SAML /
     * LDAP sessions, and for OIDC sessions where the provider didn't
     * include `offline_access` scope.
     */
    oidcRefreshTokenEncrypted: text("oidc_refresh_token_encrypted"),

    /**
     * Which IdP family minted this session — `"oidc" | "saml" | "ldap"`
     * for SSO sessions, `null` for local-auth sessions. The token-auth
     * path reads this to pick the recompute strategy (refresh-token
     * for OIDC, service-account-bind for LDAP, session-snapshot
     * fallback for SAML).
     */
    idpProviderType: text("idp_provider_type"),

    /**
     * Provider slug — matches the `slug` column on the corresponding
     * `oidc_providers` / `saml_providers` / `ldap_providers` row. Used
     * by the token recompute to resolve the provider config (TLS opts,
     * service account credentials, search base/filter, etc.).
     */
    idpProviderSlug: text("idp_provider_slug"),

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
