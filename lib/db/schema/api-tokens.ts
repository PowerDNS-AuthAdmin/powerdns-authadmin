/**
 * lib/db/schema/api-tokens.ts
 *
 * Personal Access Tokens for API access. Issued by the user; carry a subset
 * of the user's effective permissions.
 *
 * On issuance, the plaintext is shown ONCE in the UI and then discarded.
 * We store the Argon2id hash (same algo as passwords) plus an 8-character
 * public `prefix` for at-rest identification ("pda_pat_abcdefgh...").
 *
 * Re-verification on use: even after issuance, when the token is presented
 * we check that its `scopes` are still a subset of the user's current
 * effective permissions. Permission revocation propagates immediately.
 */

import {
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

// The `scopes` column stores values from the master permission vocabulary
// defined in `lib/rbac/permissions.ts` (the `Permission` type). We don't
// import that type here: the `lib/db → lib/rbac` direction is forbidden
// by the architecture. The runtime intersection check happens at the
// token-scope-narrowing layer above the DB.
type StoredPermission = string;

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Operator-chosen display name. "CI for repo X", "personal CLI", etc.
    name: text("name").notNull(),

    // Argon2id hash of the plaintext token. We never store the plaintext.
    tokenHash: text("token_hash").notNull(),

    // Public prefix — first 8 chars of the plaintext, kept in cleartext for
    // identifying which token a leaked log line refers to.
    // Format: `pda_pat_<prefix>` where `<prefix>` is base64url[0..8].
    prefix: text("prefix").notNull(),

    // The permissions this token can use. At issuance, this is a subset of
    // the user's effective permissions; re-verified on every use.
    scopes: jsonb("scopes").$type<StoredPermission[]>().notNull().default([]),

    // Optionally bound to a single team — narrows the token's effective
    // resource scope. NULL means "wherever the user has access".
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "cascade",
    }),

    // Lifecycle.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: inet("last_used_ip"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("api_tokens_user_idx").on(t.userId),
    prefixIdx: uniqueIndex("api_tokens_prefix_idx").on(t.prefix),
    teamIdx: index("api_tokens_team_idx").on(t.teamId),
  }),
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
