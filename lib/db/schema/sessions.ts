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

import { index, inet, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
