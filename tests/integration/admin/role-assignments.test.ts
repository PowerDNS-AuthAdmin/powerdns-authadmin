/**
 * tests/integration/admin/role-assignments.test.ts
 *
 * L-3 role-assignment guards, driven over HTTP:
 *   1. The last global Super Admin assignment cannot be removed (lockout guard —
 *      a DB invariant, so only an integration test can prove it).
 *   2. A `role.assign` holder cannot assign a role granting permissions they
 *      don't hold globally (the privilege ceiling), but CAN assign one within it.
 *   3. The same last-Super-Admin invariant on the user routes: the final enabled
 *      global Super Admin cannot be DISABLED or DELETED out of existence
 *      (GHSA-86v6-w5p9-29r8). Driven by a second, non-super-admin actor that
 *      merely holds `user.disable` / `user.delete`, so the request clears the
 *      self-action guard and actually reaches the last-Super-Admin guard.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_EMAIL,
  createAndLogin,
  createUser,
  loginAs,
  loginAsBootstrap,
  resolveRoleId,
  SYSTEM_ROLES,
  uniqueEmail,
} from "../helpers/auth";
import type { TestHttp } from "../helpers/http";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

const uniqueSlug = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** The id of the single global Super Admin remaining after a reset (bootstrap). */
async function lastSuperAdminUserId(): Promise<string> {
  const rows = await dbQuery<{ user_id: string }>(
    `SELECT ra.user_id
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id
      WHERE r.slug = 'super-admin' AND ra.scope_type = 'global'`,
  );
  expect(rows).toHaveLength(1); // only the bootstrap admin holds it post-reset
  return rows[0]!.user_id;
}

/** The bootstrap admin's user id (by email), independent of other assignments. */
async function bootstrapUserId(): Promise<string> {
  const rows = await dbQuery<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [BOOTSTRAP_EMAIL],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/**
 * Create + log in a user holding a custom global role with `permissions`,
 * within the bootstrap admin's privilege ceiling. Used to get an actor that
 * can REACH the user routes without itself being a global Super Admin.
 */
async function actorWithPerms(
  admin: TestHttp,
  label: string,
  permissions: string[],
): Promise<TestHttp> {
  const slug = uniqueSlug(label);
  await admin.sendJson("POST", "/api/admin/roles", { slug, name: label, permissions });
  const roleId = await resolveRoleId(admin, slug);
  const password = `${label}-pw-123456`;
  const { user } = await createAndLogin(admin, {
    email: uniqueEmail(label),
    name: label,
    password,
  });
  await admin.sendJson("POST", `/api/admin/users/${user.id}/role-assignments`, {
    roleId,
    scopeType: "global",
  });
  // Re-login so the new assignment is reflected in the session's ability.
  return loginAs(user.email, password);
}

describe("role-assignment guards (L-3)", () => {
  beforeEach(() => resetState({ skipPdns: true }));

  it("refuses to remove the last global Super Admin assignment", async () => {
    const admin = await loginAsBootstrap();
    const rows = await dbQuery<{ assignment_id: string; user_id: string }>(
      `SELECT ra.id AS assignment_id, ra.user_id
         FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
        WHERE r.slug = 'super-admin' AND ra.scope_type = 'global'`,
    );
    expect(rows).toHaveLength(1); // after reset, only the bootstrap admin holds it
    const { assignment_id, user_id } = rows[0]!;

    const res = await admin.call(`/api/admin/users/${user_id}/role-assignments/${assignment_id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);

    // …and it's still there.
    const after = await dbQuery(`SELECT id FROM role_assignments WHERE id = $1`, [assignment_id]);
    expect(after).toHaveLength(1);
  });

  it("enforces the privilege ceiling on assignment", async () => {
    const admin = await loginAsBootstrap();
    const password = "limited-assigner-pw-123456";
    const actor = await createUser(admin, {
      email: uniqueEmail("assigner"),
      name: "Limited Assigner",
      password,
    });

    // A custom role that can reach the route (role.assign) but is far short of
    // SuperAdmin. Bootstrap is SuperAdmin, so creating + granting it is allowed.
    const slug = uniqueSlug("limited-assigner");
    await admin.sendJson("POST", "/api/admin/roles", {
      slug,
      name: "Limited Assigner",
      permissions: ["role.assign", "zone.read"],
    });
    const limitedRoleId = await resolveRoleId(admin, slug);
    await admin.sendJson("POST", `/api/admin/users/${actor.id}/role-assignments`, {
      roleId: limitedRoleId,
      scopeType: "global",
    });

    const victim = await createUser(admin, {
      email: uniqueEmail("victim"),
      name: "Victim",
      password: "victim-pw-123456",
    });
    const limited = await loginAs(actor.email, password);
    const superAdminRoleId = await resolveRoleId(admin, SYSTEM_ROLES.superAdmin);

    // Over the ceiling (SuperAdmin grants perms the actor lacks) → 403.
    const bad = await limited.call(`/api/admin/users/${victim.id}/role-assignments`, {
      method: "POST",
      json: { roleId: superAdminRoleId, scopeType: "global" },
    });
    expect(bad.status).toBe(403);

    // Within the ceiling (the actor's own role) → 201.
    const ok = await limited.call(`/api/admin/users/${victim.id}/role-assignments`, {
      method: "POST",
      json: { roleId: limitedRoleId, scopeType: "global" },
    });
    expect(ok.status).toBe(201);
  });

  it("refuses to DISABLE the last global Super Admin (GHSA-86v6-w5p9-29r8)", async () => {
    const admin = await loginAsBootstrap();
    const targetId = await lastSuperAdminUserId();
    // A second actor that can disable users but is NOT a Super Admin, so the
    // request clears the self-action guard and reaches the lockout guard.
    const disabler = await actorWithPerms(admin, "disabler", ["user.update"]);

    const res = await disabler.call(`/api/admin/users/${targetId}`, {
      method: "PATCH",
      json: { disabled: true },
    });
    expect(res.status).toBe(403);

    // …and the Super Admin is still enabled.
    const rows = await dbQuery<{ disabled_at: Date | null }>(
      `SELECT disabled_at FROM users WHERE id = $1`,
      [targetId],
    );
    expect(rows[0]!.disabled_at).toBeNull();
  });

  it("refuses to DELETE the last global Super Admin (GHSA-86v6-w5p9-29r8)", async () => {
    const admin = await loginAsBootstrap();
    const targetId = await lastSuperAdminUserId();
    const deleter = await actorWithPerms(admin, "deleter", ["user.delete"]);

    const res = await deleter.call(`/api/admin/users/${targetId}`, { method: "DELETE" });
    expect(res.status).toBe(403);

    // …and the Super Admin row still exists.
    const rows = await dbQuery(`SELECT id FROM users WHERE id = $1`, [targetId]);
    expect(rows).toHaveLength(1);
  });

  it("ALLOWS disabling a Super Admin when another enabled one remains", async () => {
    const admin = await loginAsBootstrap();
    // Promote a second user to global Super Admin → now two exist.
    const superAdminRoleId = await resolveRoleId(admin, SYSTEM_ROLES.superAdmin);
    const second = await createUser(admin, {
      email: uniqueEmail("second-superadmin"),
      name: "Second Super Admin",
      password: "second-superadmin-pw-123456",
    });
    await admin.sendJson("POST", `/api/admin/users/${second.id}/role-assignments`, {
      roleId: superAdminRoleId,
      scopeType: "global",
    });

    // Bootstrap (still a Super Admin) can now disable the OTHER one — not the last.
    const res = await admin.call(`/api/admin/users/${second.id}`, {
      method: "PATCH",
      json: { disabled: true },
    });
    expect(res.status).toBe(200);

    // The second admin is now disabled, so bootstrap is again the last ENABLED
    // global Super Admin — disabling it (via the second actor) must be blocked.
    const disabler = await actorWithPerms(admin, "disabler2", ["user.update"]);
    const bootstrapId = await bootstrapUserId();
    const blocked = await disabler.call(`/api/admin/users/${bootstrapId}`, {
      method: "PATCH",
      json: { disabled: true },
    });
    expect(blocked.status).toBe(403);
  });
});
