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
  "auth.session.revoked",
  "auth.token.issued",
  "auth.token.revoked",
  "auth.oidc.linked",
  "auth.oidc.rejected_provisioning",
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

  // OIDC group → role materialisation (ADR-0012)
  "auth.oidc.group_sync.assignment_added",
  "auth.oidc.group_sync.assignment_removed",
  "auth.oidc.group_sync.mapping_unresolved",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
