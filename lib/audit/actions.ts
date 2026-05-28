/**
 * lib/audit/actions.ts
 *
 * The action vocabulary. Every audit entry's `action` field uses one of these
 * strings. Adding a new action: add the literal here, then use it.
 *
 * Naming convention: `<resource>.<verb>` matches `lib/rbac/permissions.ts`
 * where there's a 1:1 mapping (`zone.delete` action ↔ `zone.delete` perm),
 * with additional state-change actions that don't have a corresponding
 * permission (e.g. `auth.login` — anyone can attempt to log in).
 */

import "server-only";

export const AUDIT_ACTIONS = [
  // Auth
  "auth.login.success",
  "auth.login.failure",
  "auth.logout",
  "auth.password.changed",
  "auth.mfa.enrolled",
  "auth.mfa.removed",
  "auth.mfa.webauthn.enrolled",
  "auth.mfa.webauthn.removed",
  "auth.mfa.webauthn.renamed",
  "auth.session.revoked",
  "auth.token.issued",
  "auth.token.revoked",
  // External IdP events — emitted by OIDC, SAML, and LDAP sign-in paths.
  // The `after` snapshot carries `method: "oidc" | "saml" | "ldap"` and
  // `provider: "<slug>"` so audit search can filter by protocol or by
  // specific provider without needing per-protocol action names.
  "auth.idp.linked",
  "auth.idp.rejected_provisioning",
  // Self-service signup (SIGNUP_ENABLED) refused before any user row is
  // created — currently only the email-domain allow-list rejection. The
  // successful-signup path reuses `user.create` (source: signup).
  "auth.signup.rejected",
  "auth.password.reset.requested",
  "auth.password.reset.completed",
  "auth.password.reset.invalid",
  "auth.email.verify.sent",
  "auth.email.verify.completed",
  "auth.email.verify.invalid",
  "auth.email.change.requested",
  "auth.email.change.completed",
  "auth.email.change.invalid",

  // Users
  "user.create",
  "user.update",
  "user.disable",
  "user.enable",
  "user.delete",
  "user.password.reset",
  "user.session.revoked",
  "user.sessions.revoked",
  "user.sessions.revoked_all",

  // Teams
  "team.create",
  "team.update",
  "team.delete",
  "team.member.added",
  "team.member.removed",

  // Roles + assignments
  "role.create",
  "role.update",
  "role.delete",
  "role.assignment.created",
  "role.assignment.deleted",

  // Settings
  "settings.write",

  // Audit log itself
  "audit.export",

  // OIDC providers
  "oidc.provider.created",
  "oidc.provider.updated",
  "oidc.provider.deleted",
  // SAML providers (ADR-0021)
  "saml.provider.created",
  "saml.provider.updated",
  "saml.provider.deleted",

  // LDAP providers (ADR-0020). Sign-in events reuse the generic
  // `auth.login.success` / `auth.login.failure` vocabulary; the after-
  // state carries `method: "ldap"` (and `provider: "<slug>"`) to
  // disambiguate without an extra action.
  "ldap.provider.created",
  "ldap.provider.updated",
  "ldap.provider.deleted",
  // Fleet-level refresh of every enabled provider's discovery cache
  // (T-107). One audit row per operator click — per-provider cache
  // writes don't audit individually (would dwarf the signal).
  "oidc.provider.refresh-all",

  // Fleet-level refresh of every active PDNS backend's
  // version_cache (T-110). Sister action to oidc.provider.refresh-all.
  "pdns_server.refresh-all",

  // Zones / records
  "zone.create",
  "zone.update",
  "zone.delete",
  "zone.notify",
  "zone.metadata.set",
  "zone.metadata.delete",
  "zone.settings.update",
  "zone.grant.create",
  "zone.grant.delete",
  "dnssec.cryptokey.create",
  "dnssec.cryptokey.update",
  "dnssec.cryptokey.delete",

  // TSIG keys
  "tsig.create",
  "tsig.delete",
  "tsig.reveal",
  "tsig.install-secondaries",
  "tsig.manual-reveal",
  "zone.tsig-transfer.set",

  // Autoprimaries
  "autoprimary.create",
  "autoprimary.delete",

  // Zone templates
  "template.create",
  "template.update",
  "template.delete",
  "record.create",
  "record.update",
  "record.delete",

  // Servers
  "server.create",
  "server.update",
  "server.delete",
  "server.cluster.assigned",
  "server.cluster.removed",

  // Multi-primary clusters
  "cluster.create",
  "cluster.update",
  "cluster.delete",

  // First-boot provisioning (ADR-0012)
  "provisioning.applied",
  "provisioning.skipped",
  "provisioning.failed",

  // IdP group → permission resolution. One row per sign-in when a
  // mapping references a role slug that no longer exists. Protocol-
  // neutral: OIDC, SAML, and LDAP all emit it with `provider` in the
  // `after` snapshot.
  "auth.group_sync.mapping_unresolved",
  // Live recompute of IdP-derived permissions on the token-auth path.
  // One row per cache miss — at most one per user per
  // `IDP_PERMS_CACHE_TTL_SECONDS` window. `after` carries the provider
  // slug + type and the count of derived ability sources, so audit
  // search can spot "a user's perms shifted under them" patterns.
  "auth.token.idp_perms_refreshed",

  // Super-admin-gated app-DB backup. Excludes PDNS zone data and
  // symmetric secrets. The `after` snapshot carries row counts per
  // table — useful for audit search to spot empty / partial exports.
  "system.backup.exported",
  "system.backup.restored",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
