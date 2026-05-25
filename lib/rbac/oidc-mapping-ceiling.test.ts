/**
 * lib/rbac/oidc-mapping-ceiling.test.ts
 *
 * Unit cover for the OIDC group→role ceiling wrapper (GHSA-wf29-rmhc-rqc9).
 * The DB repo is mocked so the wrapper's branches (empty, unknown-role,
 * within-ceiling, over-ceiling) are exercised without a database; the
 * full-stack path is covered separately by the integration suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/db/schema";
import type { Permission } from "./permissions";

vi.mock("@/lib/db/repositories/roles", () => ({
  findRolesBySlugs: vi.fn(),
  loadUserAssignmentsForAbility: vi.fn(),
}));

import { findRolesBySlugs, loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { assertGroupMappingsWithinCeiling } from "./oidc-mapping-ceiling";

const mockFindRoles = vi.mocked(findRolesBySlugs);
const mockLoadAssignments = vi.mocked(loadUserAssignmentsForAbility);

/** Set the acting user's GLOBAL permission set. */
function actorGlobal(perms: Permission[]): void {
  mockLoadAssignments.mockResolvedValue([
    { permissions: perms, scopeType: "global", scopeId: null },
  ]);
}

/** Register the roles a slug lookup resolves to. */
function rolesBySlug(map: Record<string, Permission[]>): void {
  const rows = Object.entries(map).map(([slug, permissions]) => ({ slug, permissions }));
  mockFindRoles.mockResolvedValue(rows as unknown as Role[]);
}

describe("assertGroupMappingsWithinCeiling", () => {
  beforeEach(() => {
    mockFindRoles.mockReset();
    mockLoadAssignments.mockReset();
  });

  it("no-ops on empty / null mappings (no DB calls)", async () => {
    await expect(assertGroupMappingsWithinCeiling("actor", [])).resolves.toBeUndefined();
    await expect(assertGroupMappingsWithinCeiling("actor", null)).resolves.toBeUndefined();
    expect(mockFindRoles).not.toHaveBeenCalled();
    expect(mockLoadAssignments).not.toHaveBeenCalled();
  });

  it("rejects a mapping to an unknown role slug", async () => {
    rolesBySlug({ viewer: ["audit.read"] });
    actorGlobal(["audit.read"]);
    await expect(
      assertGroupMappingsWithinCeiling("actor", [{ group: "g", roleSlug: "ghost" }]),
    ).rejects.toThrow(/unknown role/i);
  });

  it("passes when every mapped role is within the actor's global ceiling", async () => {
    rolesBySlug({ viewer: ["audit.read"] });
    actorGlobal(["audit.read", "user.delete"]);
    await expect(
      assertGroupMappingsWithinCeiling("actor", [{ group: "ops", roleSlug: "viewer" }]),
    ).resolves.toBeUndefined();
  });

  it("rejects a mapping whose role grants a permission the actor lacks globally", async () => {
    rolesBySlug({ superusers: ["user.delete"] });
    actorGlobal(["audit.read"]); // actor does NOT hold user.delete
    await expect(
      assertGroupMappingsWithinCeiling("actor", [{ group: "admins", roleSlug: "superusers" }]),
    ).rejects.toThrow(/user\.delete/);
  });
});
