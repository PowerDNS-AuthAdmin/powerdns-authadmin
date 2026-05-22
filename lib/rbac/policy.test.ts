/**
 * lib/rbac/policy.test.ts
 *
 * RBAC is one of the load-bearing security boundaries. These tests cover the
 * scope-matching logic — the part most likely to drift if someone refactors
 * `ability.ts`.
 */

import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildAbility } from "./ability";
import { can, requirePermission } from "./policy";

const ZONE_A = { __type: "Zone" as const, id: "zone-a", teamId: "team-1" };
const ZONE_B = { __type: "Zone" as const, id: "zone-b", teamId: "team-2" };

describe("RBAC policy", () => {
  it("global scope grants on every team", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "global", scopeId: null },
    ]);
    expect(can(ability, "read", ZONE_A)).toBe(true);
    expect(can(ability, "read", ZONE_B)).toBe(true);
  });

  it("team scope grants only on matching team", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "team", scopeId: "team-1" },
    ]);
    expect(can(ability, "read", ZONE_A)).toBe(true);
    expect(can(ability, "read", ZONE_B)).toBe(false);
  });

  it("zone scope grants only on the named zone", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "zone", scopeId: "zone-a" },
    ]);
    expect(can(ability, "read", ZONE_A)).toBe(true);
    expect(can(ability, "read", ZONE_B)).toBe(false);
  });

  it("missing permission denies regardless of scope", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "global", scopeId: null },
    ]);
    expect(can(ability, "delete", ZONE_A)).toBe(false);
  });

  it("requirePermission throws ForbiddenError on deny", () => {
    const ability = buildAbility([]);
    expect(() => requirePermission(ability, "read", ZONE_A)).toThrow(ForbiddenError);
  });

  it("requirePermission is silent on allow", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "global", scopeId: null },
    ]);
    expect(() => requirePermission(ability, "read", ZONE_A)).not.toThrow();
  });

  it("aggregates multiple sources (multiple role assignments)", () => {
    const ability = buildAbility([
      { permissions: ["zone.read"], scopeType: "team", scopeId: "team-1" },
      { permissions: ["zone.read"], scopeType: "zone", scopeId: "zone-b" },
    ]);
    expect(can(ability, "read", ZONE_A)).toBe(true); // via team scope
    expect(can(ability, "read", ZONE_B)).toBe(true); // via zone scope
    expect(
      can(ability, "read", {
        __type: "Zone",
        id: "zone-c",
        teamId: "team-3",
      }),
    ).toBe(false); // neither scope matches
  });
});
