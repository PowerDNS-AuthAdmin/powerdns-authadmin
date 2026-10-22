/**
 * lib/auth/providers/group-sync.test.ts
 *
 * Pure-function coverage for the diff + claim-reader. The DB-touching
 * `computeGroupSync` is exercised by an integration test under
 * `tests/integration/`; the diff logic captured here is what determines
 * correctness.
 */

import { describe, expect, it } from "vitest";
import {
  diffGroupSync,
  mappingForForm,
  readGroupClaim,
  resolveMappingScopeId,
  type ResolvedAssignment,
} from "./group-sync-pure";

const mapping = (group: string, roleSlug: string) =>
  ({ group, roleSlug, scopeType: "global", scopeId: null }) as const;

const target = (
  roleId: string,
  scopeType: "global" | "team",
  scopeId: string | null,
): ResolvedAssignment => ({
  roleId,
  scopeType,
  scopeId,
  source: mapping("g", "r"),
});

const existing = (id: string, roleId: string, scopeType: string, scopeId: string | null) => ({
  id,
  roleId,
  scopeType,
  scopeId,
});

describe("diffGroupSync", () => {
  it("returns empty add/remove when target matches existing", () => {
    const diff = diffGroupSync(
      [target("role-a", "global", null), target("role-b", "team", "t1")],
      [existing("row-1", "role-a", "global", null), existing("row-2", "role-b", "team", "t1")],
    );
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  it("adds rows present in target but not existing", () => {
    const diff = diffGroupSync(
      [target("role-a", "global", null), target("role-b", "global", null)],
      [existing("row-1", "role-a", "global", null)],
    );
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0]!.roleId).toBe("role-b");
    expect(diff.remove).toEqual([]);
  });

  it("removes rows present in existing but not target", () => {
    const diff = diffGroupSync(
      [target("role-a", "global", null)],
      [existing("row-1", "role-a", "global", null), existing("row-2", "role-b", "global", null)],
    );
    expect(diff.add).toEqual([]);
    expect(diff.remove).toHaveLength(1);
    expect(diff.remove[0]!.id).toBe("row-2");
  });

  it("treats same role at different scopes as separate keys", () => {
    const diff = diffGroupSync(
      [target("role-a", "team", "t1"), target("role-a", "team", "t2")],
      [existing("row-1", "role-a", "team", "t1")],
    );
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0]!.scopeId).toBe("t2");
    expect(diff.remove).toEqual([]);
  });

  it("handles a complete swap (drop everything, replace with new set)", () => {
    const diff = diffGroupSync(
      [target("role-c", "global", null)],
      [existing("row-1", "role-a", "global", null), existing("row-2", "role-b", "team", "t1")],
    );
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0]!.roleId).toBe("role-c");
    expect(diff.remove).toHaveLength(2);
  });
});

describe("readGroupClaim", () => {
  it("accepts a string array", () => {
    expect(readGroupClaim(["admins", "ops"])).toEqual(new Set(["admins", "ops"]));
  });

  it("rejects non-string items inside an array", () => {
    expect(readGroupClaim(["admins", 42, null, "ops"])).toEqual(new Set(["admins", "ops"]));
  });

  it("splits a comma-separated string", () => {
    expect(readGroupClaim("admins, ops, eng")).toEqual(new Set(["admins", "ops", "eng"]));
  });

  it("splits a whitespace-separated string", () => {
    expect(readGroupClaim("admins ops eng")).toEqual(new Set(["admins", "ops", "eng"]));
  });

  it("returns empty for null / undefined / objects", () => {
    expect(readGroupClaim(null)).toEqual(new Set());
    expect(readGroupClaim(undefined)).toEqual(new Set());
    expect(readGroupClaim({})).toEqual(new Set());
    expect(readGroupClaim(123)).toEqual(new Set());
  });

  it("returns empty for an empty string", () => {
    expect(readGroupClaim("")).toEqual(new Set());
  });
});

describe("resolveMappingScopeId", () => {
  const targets = {
    teams: [{ id: "8d6f0c1e-team-uuid", slug: "noc" }],
    servers: [{ id: "2b7a9e44-server-uuid", slug: "primary-a" }],
  };
  const scoped = (scopeType: "global" | "team" | "zone" | "server", scopeId: string | null) => ({
    scopeType,
    scopeId,
  });

  it("resolves a team or server slug saved from the admin form to its id", () => {
    expect(resolveMappingScopeId(scoped("team", "noc"), targets)).toBe("8d6f0c1e-team-uuid");
    expect(resolveMappingScopeId(scoped("server", "primary-a"), targets)).toBe(
      "2b7a9e44-server-uuid",
    );
  });

  it("keeps an id written by provisioning", () => {
    expect(resolveMappingScopeId(scoped("team", "8d6f0c1e-team-uuid"), targets)).toBe(
      "8d6f0c1e-team-uuid",
    );
  });

  it("fails closed on a reference that names nothing", () => {
    expect(resolveMappingScopeId(scoped("team", "gone"), targets)).toBeNull();
    expect(resolveMappingScopeId(scoped("server", "noc"), targets)).toBeNull();
  });

  it("passes global and zone scopes through", () => {
    expect(resolveMappingScopeId(scoped("global", null), targets)).toBeNull();
    expect(resolveMappingScopeId(scoped("zone", "example.com."), targets)).toBe("example.com.");
  });
});

describe("mappingForForm", () => {
  const targets = {
    teams: [{ id: "8d6f0c1e-team-uuid", slug: "noc" }],
    servers: [],
  };

  it("shows a provisioned team id as the slug the picker lists", () => {
    const m = {
      group: "g",
      roleSlug: "r",
      scopeType: "team" as const,
      scopeId: "8d6f0c1e-team-uuid",
    };
    expect(mappingForForm(m, targets).scopeId).toBe("noc");
  });

  it("leaves slugs and unknown references as stored", () => {
    const slug = { group: "g", roleSlug: "r", scopeType: "team" as const, scopeId: "noc" };
    const gone = { group: "g", roleSlug: "r", scopeType: "team" as const, scopeId: "gone" };
    expect(mappingForForm(slug, targets)).toBe(slug);
    expect(mappingForForm(gone, targets)).toBe(gone);
  });
});
