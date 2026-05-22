/**
 * lib/db/schema/oidc-providers.ts
 *
 * DB-backed OIDC identity providers. Replaces the single-provider env-only
 * config from future work — operators can now add Google / Azure / Keycloak / etc.
 * from the admin UI without restarting the app.
 *
 * Env config (`OIDC_*` in lib/env.ts) is preserved as a fallback: if this
 * table has zero rows AND `OIDC_ENABLED=true`, the login page and dispatcher
 * synthesise a virtual provider from env. As soon as the operator creates a
 * provider here, env is ignored.
 *
 * `client_secret_encrypted` uses the same AES-256-GCM envelope as PDNS API
 * keys. The plaintext secret is never returned over the wire after creation.
 */

import { boolean, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const oidcProviders = pgTable(
  "oidc_providers",
  {
    id: pk(),

    /**
     * URL-safe slug — used as the `<provider>` path segment in
     * `/api/auth/oidc/<provider>/{initiate,callback}`. Cannot be changed once
     * created (would break in-flight sign-in attempts).
     */
    slug: text("slug").notNull(),

    /** Human display name on the login button. */
    name: text("name").notNull(),

    /** OIDC issuer URL — used for discovery. */
    issuerUrl: text("issuer_url").notNull(),

    clientId: text("client_id").notNull(),

    /** AES-256-GCM envelope of the client secret. See lib/crypto/encryption.ts. */
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),

    /** Space-separated OAuth scope list. Default "openid profile email". */
    scopes: text("scopes").notNull().default("openid profile email"),

    /** Claim used as the user's email. Default "email". */
    claimEmail: text("claim_email").notNull().default("email"),

    /** Claim used as the user's display name. Default "name". */
    claimName: text("claim_name").notNull().default("name"),

    /** Soft-disable. Disabled providers stay in the DB for audit history. */
    enabled: boolean("enabled").notNull().default(true),

    /**
     * When true, hitting `/login` immediately redirects to this provider's
     * initiate URL instead of showing the form. Useful for SSO-only
     * deployments. The escape hatch is `/login?force-local=1` (sign-out
     * destinations and explicit error redirects also keep the form
     * visible). If multiple providers have this set, the most recently
     * created one wins — the admin UI warns when ticking a second one.
     */
    forceDefault: boolean("force_default").notNull().default(false),

    /**
     * When true, sign-in for an existing local account is blocked
     * unless the IdP attests `email_verified: true`. Default `false`
     * — we trust the IdP by default ("if it's federated, the IdP is
     * the source of truth for who owns this address"). Operators flip
     * it ON only for environments where the IdP lets users set
     * arbitrary unverified emails AND there's a non-trivial overlap
     * between OIDC-provisioned and local-password accounts (the
     * account-takeover scenario the check defends against).
     */
    requireEmailVerified: boolean("require_email_verified").notNull().default(false),

    /**
     * Cached result of the last operator-triggered discovery probe
     *. `null` until the first Test. Stored as jsonb:
     *   { fetchedAt: ISO string, ok: boolean, reason?: string }
     * Auto-refresh isn't wired — operators hit Test on
     * /admin/oidc-providers when they want a fresh check. The cache
     * lets the list show the last known state without probing on
     * every page render (which would round-trip the IdP each time).
     */
    discoveryCache: jsonb("discovery_cache").$type<{
      fetchedAt: string;
      ok: boolean;
      reason?: string;
    } | null>(),

    /**
     * Optional URL or inline `data:image/...` URI for a small icon
     * rendered on the provider's login button. Same shape as
     * `settings.brand_logo_url` — operators can paste a CDN URL or
     * upload a small image that gets base64-inlined. Kept narrower
     * by validator (~50KB cap, much smaller than the brand logo's
     * 2MB) since login-button icons should be tiny.
     */
    iconUrl: text("icon_url"),

    /**
     * Per-provider email-domain allow-list override (S-7 follow-up).
     * Null = inherit the env `OIDC_ALLOWED_EMAIL_DOMAINS` default.
     * Empty array = "no restriction" at the provider level even when
     * env imposes one. Non-empty array = exact list for THIS provider
     * (replaces env, doesn't append — operators wanting to extend
     * should include the env list verbatim plus their additions).
     * Compared case-insensitively against the part after `@`.
     */
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),

    /**
     * Group → role-assignment mappings. On every successful OIDC sign-in,
     * the user's group claim (`claim_groups`, default "groups") is matched
     * against this list and the matching role assignments are materialised
     * with `role_assignments.provider_id = this.id`. The next sign-in
     * recomputes the set — removed group → revoked assignment.
     *
     * Empty array / null disables group-based materialisation for this
     * provider; admin-issued assignments are unaffected (only rows with
     * matching provider_id are touched).
     *
     * `scopeId` semantics:
     *   - scopeType = "global"  → scopeId must be null
     *   - scopeType = "team"    → team slug (resolved to team.id at
     *                             materialisation time)
     *   - scopeType = "zone"    → canonical zone name (no FK in the DB)
     *   - scopeType = "server"  → pdns_servers slug (resolved to id)
     *
     * `roleSlug` resolves to roles.id; system + custom roles both work.
     * Mappings whose group / role / scope target can't be resolved at
     * sign-in are skipped and audited; the rest of the sign-in proceeds.
     */
    groupMappings: jsonb("group_mappings").$type<OidcGroupMapping[]>(),

    /**
     * Claim name carrying the user's group memberships. Defaults to
     * "groups" (Keycloak/Authentik/Okta convention). The claim value is
     * expected to be an array of strings; non-array shapes are ignored.
     */
    claimGroups: text("claim_groups").notNull().default("groups"),

    /** Who added it. NULL for env-seeded providers. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("oidc_providers_slug_idx").on(t.slug),
  }),
);

export type OidcProvider = typeof oidcProviders.$inferSelect;
export type NewOidcProvider = typeof oidcProviders.$inferInsert;

/**
 * One group → role-assignment rule. Stored as a JSON array on
 * `oidc_providers.group_mappings`. Resolution rules + lifecycle live in
 * the schema column comment above.
 */
export interface OidcGroupMapping {
  /** Exact group value to match in the user's group claim. Case-sensitive. */
  group: string;
  /** Role slug to assign — system or custom; resolved at sign-in time. */
  roleSlug: string;
  /** Assignment scope. */
  scopeType: "global" | "team" | "zone" | "server";
  /**
   * Scope target. Null when scopeType = "global". For team / server scopes
   * this is the SLUG (resolved to the row's UUID at sign-in). For zone
   * scope, the canonical zone name (no FK).
   */
  scopeId: string | null;
}
