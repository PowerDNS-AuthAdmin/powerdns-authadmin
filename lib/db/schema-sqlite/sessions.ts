/**
 * lib/db/schema-sqlite/sessions.ts - SQLite mirror of `../schema/sessions.ts`.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const sessions = sqliteTable(
  "sessions",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),

    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),

    ip: text("ip"),
    userAgent: text("user_agent"),

    csrfSecret: text("csrf_secret").notNull(),

    // See lib/db/schema/sessions.ts for the RP-initiated-logout rationale.
    oidcEndSessionUrl: text("oidc_end_session_url"),
    oidcIdToken: text("oidc_id_token"),
    oidcClientId: text("oidc_client_id"),

    // See lib/db/schema/sessions.ts for the session-scoped IdP-derived
    // permissions rationale. JSON-stringified array of AbilitySource.
    derivedPermissions: text("derived_permissions", { mode: "json" })
      .$type<
        Array<{
          permissions: readonly string[];
          scopeType: "global" | "team" | "zone" | "server";
          scopeId: string | null;
        }>
      >()
      .notNull()
      .default([]),

    // Encrypted OIDC refresh token; null for non-OIDC or when the IdP
    // didn't include offline_access. See PG mirror for the full rationale.
    oidcRefreshTokenEncrypted: text("oidc_refresh_token_encrypted"),

    // IdP family + slug - the token-auth path reads these to pick
    // the right recompute strategy (LDAP / OIDC / SAML-fallback).
    // See PG mirror for the full rationale.
    idpProviderType: text("idp_provider_type"),
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
