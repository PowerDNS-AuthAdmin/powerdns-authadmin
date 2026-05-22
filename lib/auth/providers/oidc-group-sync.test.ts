/**
 * lib/auth/providers/oidc-group-sync.test.ts
 *
 * Pure-function coverage for the diff + claim-reader. The DB-touching
 * `applyGroupSync` is exercised by an integration test under
 * `tests/integration/` once it lands; the diff logic captured here is
 * what determines correctness — the SQL side is straight insert/delete.
 */

import { describe, expect, it } from "vitest";
import { diffGroupSync, readGroupClaim, type ResolvedAssignment } from "./oidc-group-sync-pure";

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
