/**
 * lib/db/schema/users.ts
 *
 * Identity table. A row here represents a person (or service account) who can
 * sign in. SSO-only users have `password_hash = NULL`; local users always have
 * one.
 *
 * MFA state lives on the user row (TOTP) or on `webauthn_credentials` (passkeys).
 * Login lockout is tracked via `locked_until` and is set/cleared by the
 * rate-limiter on repeated failed logins.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  inet,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_helpers";

export const users = pgTable(
  "users",
  {
    id: pk(),

    // Identity. Email is the username. Case-insensitive uniqueness enforced via
    // the `lower(email)` expression index below — Drizzle has no `citext`
    // shorthand, so we store as text and constrain uniqueness on the expression.
    email: text("email").notNull(),
    name: text("name"),
    imageUrl: text("image_url"),

    // Local-auth credential. NULL when the user is SSO-only.
    passwordHash: text("password_hash"),

    // MFA. The TOTP secret is encrypted at rest via lib/crypto/encryption.ts.
    // Passkey credentials are stored as a JSON array; per-credential fields
    // described by `WebauthnCredential` below.
    totpSecretEncrypted: text("totp_secret_encrypted"),
    // Per-user MFA policy override. NULL = inherit (SSO accounts exempt,
    // otherwise any `requiresMfa` role applies); true = always require TOTP
    // (supersedes roles AND the SSO exemption); false = never require (exempt,
    // supersedes roles). Set from the admin user-detail page.
    mfaRequired: boolean("mfa_required"),
    webauthnCredentials: jsonb("webauthn_credentials")
      .$type<WebauthnCredential[]>()
      .notNull()
      .default([]),

    // Verification + lockout state.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),

    // Disabled accounts can't log in; preserves audit history vs hard delete.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    // Last successful login (for "your account was active recently" UI).
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: inet("last_login_ip"),

    // Whether the user must change their password on next login. Set by the
    // bootstrap admin path and by admin password resets.
    mustChangePassword: boolean("must_change_password").notNull().default(false),

    // Last time `password_hash` was set (or rotated). Used by the
    // signed-token reset flow to enforce single-use: a reset token
    // minted before this timestamp is no longer redeemable, so an
    // operator who completed one reset (or whose password was changed
    // through another path) can't have a still-valid stale link.
    // Defaults to `now()` so existing rows get a sensible value at
    // migration time.
    passwordHashUpdatedAt: timestamp("password_hash_updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    ...timestamps(),
  },
  (t) => ({
    // Functional unique index on lower(email) gives case-insensitive uniqueness
    // without a citext extension.
    emailLowerIdx: uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    disabledIdx: index("users_disabled_idx").on(t.disabledAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Shape of one WebAuthn credential as we store it inside `webauthn_credentials`. */
export interface WebauthnCredential {
  /** Credential ID, base64url-encoded. */
  id: string;
  /** Public key, base64url-encoded COSE form. */
  publicKey: string;
  /** Replay counter — rejected if a verification reports a lower value. */
  counter: number;
  /** Transports the authenticator supports (e.g. ["usb","nfc"]). */
  transports?: Array<"usb" | "nfc" | "ble" | "internal" | "hybrid">;
  /** When the credential was registered. ISO string. */
  createdAt: string;
  /** Last time this credential authenticated. ISO string or null. */
  lastUsedAt: string | null;
  /** User-chosen display name. */
  nickname: string;
}
