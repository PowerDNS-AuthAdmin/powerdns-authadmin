/**
 * tests/integration/admin/roles.test.ts
 *
 * /api/admin/roles - list / create / update / delete custom roles. System
 * roles (super-admin, operator, etc.) refuse most mutations: full-field
 * PATCH and DELETE both reject. Non-admin callers get 403 on create.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

interface RoleRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  requiresMfa: boolean;
  isSystem: boolean;
  permissions: string[];
}

function uniqueRoleSlug(prefix = "role"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/roles", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET list includes every system role", async () => {
    const admin = await loginAsBootstrap();
    const { roles } = await admin.getJson<{ roles: RoleRow[] }>("/api/admin/roles");
    const slugs = roles.map((r) => r.slug);
    for (const expected of Object.values(SYSTEM_ROLES)) {
      expect(slugs).toContain(expected);
    }
    const sa = roles.find((r) => r.slug === SYSTEM_ROLES.superAdmin);
    expect(sa?.isSystem).toBe(true);
  });

  it("POST creates a custom role with a permission set", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueRoleSlug("custom");
    const res = await admin.call("/api/admin/roles", {
      method: "POST",
      json: {
        slug,
        name: "Custom Role",
        description: "for tests",
        requiresMfa: false,
        permissions: ["zone.read", "record.read"],
      },
    });
    expect(res.status).toBe(201);
    const { role } = (await res.json()) as { role: RoleRow };
    expect(role.slug).toBe(slug);
    expect(role.isSystem).toBe(false);
    expect(role.permissions).toEqual(expect.arrayContaining(["zone.read", "record.read"]));
  });

  it("PATCH updates permissions on a custom role", async () => {
    const admin = await loginAsBootstrap();
    const { role } = await admin.sendJson<{ role: RoleRow }>("POST", "/api/admin/roles", {
      slug: uniqueRoleSlug("patch"),
      name: "Patch Me",
      permissions: ["zone.read"],
    });
    const updated = await admin.sendJson<{ role: RoleRow }>(
      "PATCH",
      `/api/admin/roles/${role.id}`,
      { permissions: ["zone.read", "record.read", "record.update"] },
    );
    expect(updated.role.permissions).toEqual(
      expect.arrayContaining(["zone.read", "record.read", "record.update"]),
    );
  });

  it("DELETE on a system role is refused with 400", async () => {
    const admin = await loginAsBootstrap();
    const { roles } = await admin.getJson<{ roles: RoleRow[] }>("/api/admin/roles");
    const operator = roles.find((r) => r.slug === SYSTEM_ROLES.operator);
    expect(operator).toBeDefined();
    const res = await admin.call(`/api/admin/roles/${operator!.id}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE on a custom role removes it", async () => {
    const admin = await loginAsBootstrap();
    const { role } = await admin.sendJson<{ role: RoleRow }>("POST", "/api/admin/roles", {
      slug: uniqueRoleSlug("doomed"),
      name: "Doomed",
      permissions: ["zone.read"],
    });
    await admin.sendJson("DELETE", `/api/admin/roles/${role.id}`);
    const { roles } = await admin.getJson<{ roles: RoleRow[] }>("/api/admin/roles");
    expect(roles.find((r) => r.id === role.id)).toBeUndefined();
  });

  it("non-admin (operator) cannot create roles - 403", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-role"),
      name: "Op Role",
      password: "operator-role-pass-12345",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/roles", {
      method: "POST",
      json: {
        slug: uniqueRoleSlug("forbid"),
        name: "Should Fail",
        permissions: ["zone.read"],
      },
    });
    expect(res.status).toBe(403);
  });
});
