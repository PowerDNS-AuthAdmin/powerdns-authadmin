/**
 * lib/db/schema/ldap-providers.ts
 *
 * DB-backed LDAP identity providers (ADR-0020). One row per directory; the
 * admin UI manages them under /admin/authentication/ldap. There is no env fallback
 * for LDAP — every directory is configured at runtime via the admin UI or
 * a `ldap:` block in `provisioning.yaml`.
 *
 * `bind_password_encrypted` carries the service-account password as an
 * AES-256-GCM envelope (same `lib/crypto/encryption.ts` path as the OIDC
 * client secret). The plaintext is never returned over the wire after create.
 */

import { boolean, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const ldapProviders = pgTable(
  "ldap_providers",
  {
    id: pk(),

    /** URL-safe slug. Used in the login route `/api/auth/ldap/<slug>/login`
     *  and as the audit-log resource id. Cannot be changed once created. */
    slug: text("slug").notNull(),

    /** Human display name on the login form. */
    name: text("name").notNull(),

    /**
     * Full LDAP server URL — `ldaps://host:636` (implicit TLS, preferred)
     * or `ldap://host:389` (plain, only allowed when StartTLS is configured
     * on the row OR `LDAP_ALLOW_INSECURE_PORT_389=true` env-wide).
     */
    serverUrl: text("server_url").notNull(),

    /**
     * Issue a StartTLS extended request after connecting (RFC 4511 § 4.14)
     * to upgrade an `ldap://` connection to TLS. Has no effect on `ldaps://`
     * URLs — the implicit-TLS port already speaks TLS from the first byte,
     * and most servers reject StartTLS on that connection. Validators refuse
     * the redundant pairing.
     */
    startTls: boolean("start_tls").notNull().default(false),

    /** Service-account DN we bind with FIRST, to look up the user record. */
    bindDn: text("bind_dn").notNull(),

    /** AES-256-GCM envelope of the service-account password. */
    bindPasswordEncrypted: text("bind_password_encrypted").notNull(),

    /** Base DN for the user search, e.g. `OU=Users,DC=example,DC=com`. */
    userSearchBase: text("user_search_base").notNull(),

    /**
     * RFC 4515 filter applied at the search step. `{{username}}` is replaced
     * with the LDAP-escaped username the operator typed. Default matches
     * both AD (sAMAccountName) and OpenLDAP (uid) conventions.
     */
    userSearchFilter: text("user_search_filter")
      .notNull()
      .default("(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))"),

    /** Optional second-search base for group memberships. */
    groupSearchBase: text("group_search_base"),

    /**
     * Filter for the optional second group search. `{{userDn}}` is replaced
     * with the user's DN (LDAP-escaped). Common shape:
     *   `(&(objectClass=group)(member={{userDn}}))`
     */
    groupSearchFilter: text("group_search_filter"),

    /**
     * Attribute on the user record that lists group memberships. Default
     * `memberOf` — AD's fully-resolved attribute. Read first; the second
     * search above is only invoked when this attribute is empty or absent.
     */
    groupAttr: text("group_attr").notNull().default("memberOf"),

    /** Attribute on the user record mapped to the user's email. Default `mail`. */
    claimEmail: text("claim_email").notNull().default("mail"),

    /** Attribute mapped to the display name. Default `displayName`. */
    claimName: text("claim_name").notNull().default("displayName"),

    /**
     * Optional PEM CA certificate to pin TLS against an internal CA, instead
     * of disabling verification with `LDAP_TLS_INSECURE_SKIP_VERIFY`.
     * Multiple PEM blocks concatenated are accepted.
     */
    tlsCaCert: text("tls_ca_cert"),

    /** Soft-disable. Disabled providers stay in the DB for audit history. */
    enabled: boolean("enabled").notNull().default(true),

    /**
     * Per-provider email-domain allow-list. Null = no restriction (LDAP
     * has no env-level default — operators set it explicitly per
     * provider when they want one). Empty array also = no restriction.
     */
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),

    /**
     * Group → role-assignment mappings. Same shape as OIDC's
     * `oidc_providers.group_mappings`; same `applyGroupSync` differ
     * processes them. Set membership comes from the LDAP attribute
     * named by `group_attr` (or the second search when configured).
     */
    groupMappings: jsonb("group_mappings").$type<LdapGroupMapping[]>(),

    /** Who added it. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("ldap_providers_slug_idx").on(t.slug),
  }),
);

export type LdapProvider = typeof ldapProviders.$inferSelect;
export type NewLdapProvider = typeof ldapProviders.$inferInsert;

/**
 * One group → role-assignment rule. Identical shape to the neutral
 * `GroupMapping` in `lib/auth/providers/group-sync-pure.ts`; the compute
 * path (`computeGroupSync`) is protocol-agnostic. Stored as a JSON array
 * on `ldap_providers.group_mappings`.
 */
export interface LdapGroupMapping {
  /** Exact group value to match in the LDAP group set. Case-sensitive. */
  group: string;
  /** Role slug (system or custom); resolved at sign-in time. */
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  /** Null when scopeType=global; slug or zone-fqdn otherwise. */
  scopeId: string | null;
}
