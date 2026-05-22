import { describe, expect, it } from "vitest";
import { narrowAssignmentsByTokenScopes, type NarrowableAssignment } from "./token-scope-narrowing";

function a(
  permissions: string[],
  scopeType: NarrowableAssignment["scopeType"] = "global",
  scopeId: string | null = null,
): NarrowableAssignment {
  return {
    permissions: permissions as NarrowableAssignment["permissions"],
    scopeType,
    scopeId,
  };
}

describe("narrowAssignmentsByTokenScopes", () => {
  it("returns assignments unchanged when token scopes are empty (back-compat)", () => {
    const input = [a(["zone.read", "zone.update"]), a(["user.read"])];
    const out = narrowAssignmentsByTokenScopes(input, []);
    expect(out).toEqual(input);
    // Ensure we didn't mutate.
    expect(out[0]).not.toBe(input[0]);
    expect(out[0]?.permissions).not.toBe(input[0]?.permissions);
  });

  it("filters each assignment's permissions to the intersection", () => {
    const input = [a(["zone.read", "zone.update", "zone.delete"])];
    const out = narrowAssignmentsByTokenScopes(input, ["zone.read", "zone.update"] as never);
    expect(out).toEqual([
      {
        permissions: ["zone.read", "zone.update"],
        scopeType: "global",
        scopeId: null,
      },
    ]);
  });

  it("drops assignments with no surviving permissions", () => {
    const input = [a(["zone.read"], "team", "team-a"), a(["user.delete"])];
    const out = narrowAssignmentsByTokenScopes(input, ["zone.read"] as never);
    expect(out).toEqual([
      {
        permissions: ["zone.read"],
        scopeType: "team",
        scopeId: "team-a",
      },
    ]);
  });

  it("returns an empty array when no permissions overlap", () => {
    const out = narrowAssignmentsByTokenScopes([a(["zone.read", "zone.update"])], [
      "user.read",
    ] as never);
    expect(out).toEqual([]);
  });

  it("preserves scopeType and scopeId on each surviving assignment", () => {
    const input = [
      a(["zone.read", "zone.update"], "zone", "zone-uuid-1"),
      a(["zone.read"], "team", "team-uuid-1"),
    ];
    const out = narrowAssignmentsByTokenScopes(input, ["zone.read"] as never);
    expect(out).toEqual([
      {
        permissions: ["zone.read"],
        scopeType: "zone",
        scopeId: "zone-uuid-1",
      },
      {
        permissions: ["zone.read"],
        scopeType: "team",
        scopeId: "team-uuid-1",
      },
    ]);
  });

  it("doesn't grant permissions the user lacks (floor semantics)", () => {
    // User only has zone.read; token requests zone.read AND zone.delete.
    // Result: only zone.read survives.
    const out = narrowAssignmentsByTokenScopes([a(["zone.read"])], [
      "zone.read",
      "zone.delete",
    ] as never);
    expect(out[0]?.permissions).toEqual(["zone.read"]);
  });

  it("preserves order of input assignments", () => {
    const input = [
      a(["zone.read"], "team", "a"),
      a(["zone.read"], "team", "b"),
      a(["zone.read"], "team", "c"),
    ];
    const out = narrowAssignmentsByTokenScopes(input, ["zone.read"] as never);
    expect(out.map((x) => x.scopeId)).toEqual(["a", "b", "c"]);
  });
});
