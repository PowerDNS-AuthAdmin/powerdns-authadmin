/**
 * lib/auth/signup-policy.ts
 *
 * Pure policy helpers for the self-service signup flow (`SIGNUP_ENABLED`).
 * DB-free and HTTP-free so the boot-time guard and the route can both unit-test
 * the rules without dragging in `pg` / Next.
 *
 * The central rule: a self-service signup may only ever receive a LOW-PRIVILEGE
 * role. A misconfigured `SIGNUP_DEFAULT_ROLE` pointing at an admin role would
 * silently turn public signup into "anyone can become an admin", so we refuse to
 * boot when the configured role carries any admin-equivalent permission.
 */

import "server-only";
import { SUPER_ADMIN_SLUG } from "@/lib/rbac/default-roles";
import type { Permission } from "@/lib/rbac/permissions";

/**
 * Permissions that, if held, make a role admin-equivalent for the purposes of
 * the signup guard. These are the cross-tenant / identity / infrastructure
 * capabilities that must never be reachable by self-registration. The list is
 * intentionally conservative — anything that lets the holder grant themselves
 * more power, manage other identities, change app-wide settings, or read the
 * audit trail counts.
 *
 * This is a denylist (rather than "must be a subset of read-only") so an
 * operator can safely point `SIGNUP_DEFAULT_ROLE` at a bespoke low-privilege
 * role that, say, also grants `zone.create` — without us blocking a perfectly
 * reasonable choice. We only block the genuinely dangerous capabilities.
 */
export const ADMIN_EQUIVALENT_PERMISSIONS: readonly Permission[] = [
  // Identity management — could create/alter/disable other users.
  "user.create",
  "user.update",
  "user.delete",
  "user.disable",
  "user.reset-password",
  // Role management + assignment — the privilege-escalation vector.
  "role.create",
  "role.update",
  "role.delete",
  "role.assign",
  // App-wide settings + the OIDC trust config.
  "settings.write",
  "oidc.manage",
  // Audit trail visibility.
  "audit.read",
  // Backend (PDNS server) management.
  "server.create",
  "server.update",
  "server.delete",
  // Team lifecycle (creating/deleting teams + moving members between them).
  "team.create",
  "team.delete",
  // Fleet-wide token visibility/control.
  "token.read.all",
  "token.delete.all",
] as const;

/**
 * True when a role with these permissions (and slug) is too privileged to be
 * the default for self-service signup. The super-admin slug is always refused
 * regardless of its current permission set (defense against a future edit that
 * empties its permissions but keeps the slug as the privileged anchor used by
 * the last-SuperAdmin guard).
 */
export function isAdminEquivalentRole(role: {
  slug: string;
  permissions: readonly string[];
}): boolean {
  if (role.slug === SUPER_ADMIN_SLUG) return true;
  const held = new Set(role.permissions);
  return ADMIN_EQUIVALENT_PERMISSIONS.some((p) => held.has(p));
}

/**
 * Validate a candidate `SIGNUP_DEFAULT_ROLE` against a resolved role row.
 * Returns a structured result the caller turns into a loud boot failure.
 *
 *   - `null` role → the configured slug doesn't exist.
 *   - admin-equivalent role → refused (the whole point of the guard).
 *   - otherwise → ok.
 */
export type SignupDefaultRoleCheck =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "admin-equivalent" };

export function checkSignupDefaultRole(
  role: { slug: string; permissions: readonly string[] } | null,
): SignupDefaultRoleCheck {
  if (!role) return { ok: false, reason: "missing" };
  if (isAdminEquivalentRole(role)) return { ok: false, reason: "admin-equivalent" };
  return { ok: true };
}
