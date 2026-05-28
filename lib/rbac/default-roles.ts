/**
 * lib/rbac/default-roles.ts
 *
 * The seeded "system" roles. These are created on first boot by the seed
 * script and protected from deletion (the `is_system` column).
 *
 * Operators can add their own custom roles in the admin UI; the system roles
 * are a sensible default preset that covers the common cases.
 */

import "server-only";
import type { Permission } from "./permissions";

/** Slug of the seeded all-permissions role. Used by the last-SuperAdmin guard. */
export const SUPER_ADMIN_SLUG = "super-admin";

export interface DefaultRoleSpec {
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
}

/**
 * Read-only — can see, can't touch. Useful for auditors, on-call observers,
 * or as a temporary scope while training someone.
 */
const READ_ONLY: Permission[] = [
  "zone.read",
  "record.read",
  "dnssec.read",
  "metadata.read",
  "template.use",
  "team.read",
  "user.read",
  "role.read",
  "server.read",
  "token.read.own",
  "settings.read",
];

/** ZoneEditor — can manage records on assigned zones. No structural changes. */
const ZONE_EDITOR: Permission[] = [
  ...READ_ONLY,
  "record.create",
  "record.update",
  "record.delete",
  "token.create.own",
  "token.delete.own",
];

/** Operator — typical day-to-day admin scope within a team. */
const OPERATOR: Permission[] = [
  ...ZONE_EDITOR,
  "zone.create",
  "zone.update",
  "zone.delete",
  "zone.import",
  "zone.export",
  "metadata.write",
  "template.manage",
];

/** TeamOwner — full control of their team + member management. */
const TEAM_OWNER: Permission[] = [
  ...OPERATOR,
  "dnssec.configure",
  // `tsig.read` (list keys) is granted alongside `tsig.manage` — managing
  // implies seeing the list, and the /admin/tsig-keys page guards on
  // `tsig.read`. Without this pairing the page is unreachable even for
  // SuperAdmin (which spreads this list).
  "tsig.read",
  "tsig.manage",
  "autoprimary.manage",
  "team.update",
  "team.manage-members",
];

/** SuperAdmin — every permission. The seed script asserts this contains them all. */
const SUPER_ADMIN: Permission[] = [
  ...TEAM_OWNER,
  "team.create",
  "team.delete",
  "user.create",
  "user.update",
  "user.delete",
  "user.disable",
  "user.reset-password",
  "role.create",
  "role.update",
  "role.delete",
  "role.assign",
  "server.create",
  "server.update",
  "server.delete",
  "token.read.all",
  "token.delete.all",
  "audit.read",
  "settings.write",
  "auth.read",
  "auth.manage",
  "system.backup",
];

export const DEFAULT_ROLES: readonly DefaultRoleSpec[] = [
  {
    slug: SUPER_ADMIN_SLUG,
    name: "Super Admin",
    description: "Full access to everything: users, roles, servers, settings, audit.",
    permissions: SUPER_ADMIN,
  },
  {
    slug: "team-owner",
    name: "Team Owner",
    description:
      "Full control of a team's zones and members. Cannot manage other teams or app-wide settings.",
    permissions: TEAM_OWNER,
  },
  {
    slug: "operator",
    name: "Operator",
    description:
      "Day-to-day zone and record administration within a team. No DNSSEC or member management.",
    permissions: OPERATOR,
  },
  {
    slug: "zone-editor",
    name: "Zone Editor",
    description: "Edit records on assigned zones. Cannot create or delete zones.",
    permissions: ZONE_EDITOR,
  },
  {
    slug: "read-only",
    name: "Read Only",
    description: "View access to assigned zones. No changes. Useful for auditors and observers.",
    permissions: READ_ONLY,
  },
];
