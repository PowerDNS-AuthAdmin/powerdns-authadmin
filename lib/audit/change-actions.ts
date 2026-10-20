/**
 * lib/audit/change-actions.ts
 *
 * Which audit actions are *changes*: something a person (or a token, or
 * provisioning) altered - a record, a zone, DNSSEC, an account, a setting.
 * The Change log (/admin/changes) is the audit log filtered to these; the
 * audit log keeps everything else too (sign-ins, reads, reveals, NOTIFYs).
 *
 * Every action in the vocabulary is classified exactly once, as a category
 * or as NOT_CHANGES, and change-actions.test.ts enforces it, so a new action
 * cannot silently stay out of (or wrongly land in) the Change log.
 *
 * Pure: no server-only import, so the client can label categories too.
 */

export const CHANGE_CATEGORIES = ["records", "zones", "dnssec", "access", "config"] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export const CHANGE_CATEGORY_LABEL: Record<ChangeCategory, string> = {
  records: "Records",
  zones: "Zones",
  dnssec: "DNSSEC",
  access: "Users & access",
  config: "Configuration",
};

export const CHANGE_ACTIONS_BY_CATEGORY: Record<ChangeCategory, readonly string[]> = {
  records: ["record.create", "record.update", "record.delete", "record.ptr-sync"],
  zones: [
    "zone.create",
    "zone.delete",
    "zone.update",
    "zone.settings.update",
    "zone.horizon.update",
    "zone.metadata.set",
    "zone.metadata.delete",
    "zone.tsig-transfer.set",
  ],
  dnssec: [
    "dnssec.enable",
    "dnssec.disable",
    "dnssec.rectify",
    "dnssec.cryptokey.create",
    "dnssec.cryptokey.update",
    "dnssec.cryptokey.delete",
  ],
  access: [
    "user.create",
    "user.update",
    "user.delete",
    "user.disable",
    "user.enable",
    "user.password.reset",
    "user.session.revoked",
    "user.sessions.revoked",
    "user.sessions.revoked_all",
    "auth.password.changed",
    "auth.password.reset.completed",
    "auth.email.change.completed",
    "auth.mfa.enrolled",
    "auth.mfa.removed",
    "auth.mfa.webauthn.enrolled",
    "auth.mfa.webauthn.removed",
    "auth.mfa.webauthn.renamed",
    "auth.session.revoked",
    "auth.token.issued",
    "auth.token.revoked",
    "auth.idp.linked",
    "role.create",
    "role.update",
    "role.delete",
    "role.assignment.created",
    "role.assignment.deleted",
    "team.create",
    "team.update",
    "team.delete",
    "team.member.added",
    "team.member.removed",
    "team.member.role_changed",
    "zone.grant.create",
    "zone.grant.delete",
  ],
  config: [
    "settings.write",
    "server.create",
    "server.update",
    "server.delete",
    "server.cluster.assigned",
    "server.cluster.removed",
    "cluster.create",
    "cluster.update",
    "cluster.delete",
    "template.create",
    "template.update",
    "template.delete",
    "tsig.create",
    "tsig.delete",
    "tsig.install-secondaries",
    "autoprimary.create",
    "autoprimary.delete",
    "oidc.provider.created",
    "oidc.provider.updated",
    "oidc.provider.deleted",
    "saml.provider.created",
    "saml.provider.updated",
    "saml.provider.deleted",
    "ldap.provider.created",
    "ldap.provider.updated",
    "ldap.provider.deleted",
    "system.backup.restored",
    "provisioning.applied",
  ],
};

/**
 * Audit actions that are deliberately NOT changes: sign-in events, reads and
 * reveals, exports, connection tests, NOTIFYs, requests that did not complete,
 * and bookkeeping. They stay in the audit log.
 */
export const NOT_CHANGES: readonly string[] = [
  "auth.login.success",
  "auth.login.failure",
  "auth.logout",
  "auth.token.revealed",
  "auth.token.idp_perms_refreshed",
  "auth.email.change.requested",
  "auth.email.change.invalid",
  "auth.email.verify.sent",
  "auth.email.verify.invalid",
  "auth.email.verify.completed",
  "auth.password.reset.requested",
  "auth.password.reset.invalid",
  "auth.signup.rejected",
  "auth.idp.rejected_provisioning",
  "auth.group_sync.mapping_unresolved",
  "audit.export",
  "zone.export",
  "zone.notify",
  "tsig.reveal",
  "tsig.manual-reveal",
  "oidc.provider.tested",
  "oidc.provider.refresh-all",
  "pdns_server.refresh-all",
  "backend_advisory.acknowledge",
  "system.backup.exported",
  "provisioning.failed",
  "provisioning.skipped",
];

export const CHANGE_ACTIONS: readonly string[] = CHANGE_CATEGORIES.flatMap(
  (c) => CHANGE_ACTIONS_BY_CATEGORY[c],
);

const CATEGORY_OF: ReadonlyMap<string, ChangeCategory> = new Map(
  CHANGE_CATEGORIES.flatMap((c) => CHANGE_ACTIONS_BY_CATEGORY[c].map((a) => [a, c] as const)),
);

export function changeCategoryOf(action: string): ChangeCategory | null {
  return CATEGORY_OF.get(action) ?? null;
}

export function isChangeCategory(value: string): value is ChangeCategory {
  return (CHANGE_CATEGORIES as readonly string[]).includes(value);
}

/** Resource types whose ids are `${serverSlug}:${zoneName}[:...]`. */
const ZONE_SCOPED_TYPES: ReadonlySet<string> = new Set(["zone", "rrset"]);

/**
 * The backend slug and zone of a zone-scoped audit row, read from its
 * resource id (`slug:zone.` or `slug:zone.:name|TYPE`). Null for anything
 * else. Zone names never contain ":", so the split is unambiguous.
 */
export function zoneOfResource(
  resourceType: string,
  resourceId: string | null,
): { serverSlug: string; zone: string } | null {
  if (!resourceId || !ZONE_SCOPED_TYPES.has(resourceType)) return null;
  const first = resourceId.indexOf(":");
  if (first <= 0) return null;
  const rest = resourceId.slice(first + 1);
  const second = rest.indexOf(":");
  const zone = second === -1 ? rest : rest.slice(0, second);
  if (!zone) return null;
  return { serverSlug: resourceId.slice(0, first), zone };
}
