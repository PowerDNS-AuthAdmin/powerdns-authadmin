/**
 * tests/integration/admin/role-assignments.test.ts
 *
 * L-3 role-assignment guards, driven over HTTP:
 *   1. The last global Super Admin assignment cannot be removed (lockout guard —
 *      a DB invariant, so only an integration test can prove it).
 *   2. A `role.assign` holder cannot assign a role granting permissions they
 *      don't hold globally (the privilege ceiling), but CAN assign one within it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createUser,
  loginAs,
  loginAsBootstrap,
  resolveRoleId,
  SYSTEM_ROLES,
  uniqueEmail,
} from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

const uniqueSlug = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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
});
