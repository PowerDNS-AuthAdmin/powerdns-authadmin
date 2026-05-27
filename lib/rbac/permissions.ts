/**
 * lib/rbac/permissions.ts
 *
 * The master list of permissions. Every authorization check anywhere in the
 * app names one of these strings; new permissions go through code review here
 * before they appear in role definitions or `can()` checks.
 *
 * Naming convention: `<resource>.<action>`. Resources are singular nouns
 * (zone, record, user). Actions are simple verbs (read, create, update,
 * delete, configure).
 *
 * To add a permission:
 *   1. Add the string to the `PERMISSIONS` array below.
 *   2. Add it to the default role(s) in `lib/rbac/default-roles.ts` that
 *      should have it.
 *   3. Update any docs that list the vocabulary.
 */

import "server-only";

/**
 * The canonical permission list. The `as const` makes it a literal-typed
 * tuple from which we derive the `Permission` type.
 */
export const PERMISSIONS = [
  // === Zones ===
  "zone.read",
  "zone.create",
  "zone.update",
  "zone.delete",
  "zone.export",
  "zone.import",

  // === Records ===
  "record.read",
  "record.create",
  "record.update",
  "record.delete",

  // === DNSSEC ===
  "dnssec.read",
  "dnssec.configure",

  // === Zone metadata ===
  "metadata.read",
  "metadata.write",

  // === TSIG keys ===
  // `tsig.read` gates the listing (name + algorithm only — never
  // the secret). `tsig.manage` gates create / regenerate / delete
  // AND reveal-secret. Splitting them lets operators audit the
  // configured key inventory without granting access to the
  // shared-secret material itself.
  "tsig.read",
  "tsig.manage",

  // === Autoprimaries ===
  "autoprimary.manage",

  // === Templates ===
  "template.use",
  "template.manage",

  // === Identity ===
  "user.read",
  "user.create",
  "user.update",
  "user.delete",
  "user.disable",
  "user.reset-password",

  // === Teams ===
  "team.read",
  "team.create",
  "team.update",
  "team.delete",
  "team.manage-members",

  // === Roles ===
  "role.read",
  "role.create",
  "role.update",
  "role.delete",
  "role.assign",

  // === Servers ===
  "server.read",
  "server.create",
  "server.update",
  "server.delete",

  // === API tokens ===
  "token.read.own",
  "token.create.own",
  "token.delete.own",
  "token.read.all",
  "token.delete.all",

  // === Audit + settings ===
  "audit.read",
  "settings.read",
  "settings.write",

  // === Authentication providers (OIDC, SAML, LDAP) ===
  // Renamed from the old `oidc.*` strings in #74 — the surface is no
  // longer OIDC-only; the same permission gates all three protocols at
  // the unified `/admin/auth-providers` surface.
  "auth.read",
  "auth.manage",

  // === System / backup ===
  // App-DB export + restore (#84). Reveals every configured admin object
  // (users, providers, settings, audit) and can wholesale replace them
  // on restore. Default-granted only to the seeded Super Admin role.
  "system.backup",
] as const;

/** Union type of every valid permission. */
export type Permission = (typeof PERMISSIONS)[number];
