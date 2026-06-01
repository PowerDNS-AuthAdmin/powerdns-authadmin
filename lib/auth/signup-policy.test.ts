import { describe, expect, it } from "vitest";
import {
  ADMIN_EQUIVALENT_PERMISSIONS,
  checkSignupDefaultRole,
  isAdminEquivalentRole,
} from "./signup-policy";
import { DEFAULT_ROLES, SUPER_ADMIN_SLUG } from "@/lib/rbac/default-roles";

function role(slug: string) {
  const def = DEFAULT_ROLES.find((r) => r.slug === slug);
  if (!def) throw new Error(`missing seeded role ${slug}`);
  return { slug: def.slug, permissions: def.permissions };
}

describe("isAdminEquivalentRole", () => {
  it("treats the read-only seeded role as low-privilege", () => {
    expect(isAdminEquivalentRole(role("read-only"))).toBe(false);
  });

  it("treats zone-editor as low-privilege (record edits aren't admin-equivalent)", () => {
    expect(isAdminEquivalentRole(role("zone-editor"))).toBe(false);
  });

  it("treats operator as low-privilege (zone CRUD only, no identity/settings)", () => {
    expect(isAdminEquivalentRole(role("operator"))).toBe(false);
  });

  it("flags super-admin as admin-equivalent", () => {
    expect(isAdminEquivalentRole(role(SUPER_ADMIN_SLUG))).toBe(true);
  });

  it("flags team-owner (holds tsig.manage + member mgmt but also team mgmt? check perms)", () => {
    // team-owner does NOT hold any ADMIN_EQUIVALENT permission per the denylist
    // (no user/role/settings/server/audit/team.create/team.delete/token.*.all).
    // Confirm it is therefore treated as low-privilege - a deliberate choice so
    // an operator could in principle use it, though read-only is the default.
    expect(isAdminEquivalentRole(role("team-owner"))).toBe(false);
  });

  it("flags the super-admin SLUG even if its permission set were emptied", () => {
    expect(isAdminEquivalentRole({ slug: SUPER_ADMIN_SLUG, permissions: [] })).toBe(true);
  });

  it.each(ADMIN_EQUIVALENT_PERMISSIONS)(
    "flags a custom role holding the admin-equivalent permission %s",
    (perm) => {
      expect(isAdminEquivalentRole({ slug: "custom", permissions: [perm] })).toBe(true);
    },
  );

  it("does not flag a custom role with only read + zone-create permissions", () => {
    expect(
      isAdminEquivalentRole({
        slug: "custom-low",
        permissions: ["zone.read", "zone.create", "record.update"],
      }),
    ).toBe(false);
  });
});

describe("checkSignupDefaultRole", () => {
  it("reports missing when the slug resolves to no role", () => {
    expect(checkSignupDefaultRole(null)).toEqual({ ok: false, reason: "missing" });
  });

  it("reports admin-equivalent for super-admin", () => {
    expect(checkSignupDefaultRole(role(SUPER_ADMIN_SLUG))).toEqual({
      ok: false,
      reason: "admin-equivalent",
    });
  });

  it("accepts the read-only role", () => {
    expect(checkSignupDefaultRole(role("read-only"))).toEqual({ ok: true });
  });
});
