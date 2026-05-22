/**
 * lib/db/schema-sqlite/users.ts — SQLite mirror of `../schema/users.ts`.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pk, timestamps } from "./_helpers";

export const users = sqliteTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    name: text("name"),
    imageUrl: text("image_url"),

    passwordHash: text("password_hash"),

    totpSecretEncrypted: text("totp_secret_encrypted"),
    // Per-user MFA policy override — NULL inherit / true require / false exempt.
    // Supersedes role requiresMfa (and, when set, the SSO exemption). See the
    // Postgres schema for the full semantics.
    mfaRequired: integer("mfa_required", { mode: "boolean" }),
    webauthnCredentials: text("webauthn_credentials", { mode: "json" })
      .$type<WebauthnCredential[]>()
      .notNull()
      .default([]),

    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),

    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),

    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    lastLoginIp: text("last_login_ip"),

    mustChangePassword: integer("must_change_password", { mode: "boolean" })
      .notNull()
      .default(false),

    passwordHashUpdatedAt: integer("password_hash_updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),

    ...timestamps(),
  },
  (t) => ({
    emailLowerIdx: uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    disabledIdx: index("users_disabled_idx").on(t.disabledAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export interface WebauthnCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: Array<"usb" | "nfc" | "ble" | "internal" | "hybrid">;
  createdAt: string;
  lastUsedAt: string | null;
  nickname: string;
}
