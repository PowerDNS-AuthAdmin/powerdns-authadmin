/**
 * lib/rbac/ability.test.ts
 *
 * Regression tests for the scoping fix: a type-level CASL check
 * (`ability.can(action, "Type")`) returns true for a conditionally-scoped
 * rule, so it must NOT be used as a blanket authorization decision.
 * `globalPermissionsOf` is the safe "any resource of this type" signal — it
 * counts ONLY global-scope grants. These tests pin that contract so the
 * team/zone/server-scoping guarantee can't silently regress.
 */

import { describe, expect, it } from "vitest";
import {
  buildAbility,
  globalPermissionsOf,
  permissionsExceedingGrant,
  type AbilitySource,
} from "./ability";
import type { Permission } from "./permissions";

describe("globalPermissionsOf", () => {
  it("includes permissions granted at global scope", () => {
    const sources: AbilitySource[] = [
      { permissions: ["zone.read", "record.update"], scopeType: "global", scopeId: null },
    ];
    const g = globalPermissionsOf(sources);
    expect(g.has("zone.read")).toBe(true);
    expect(g.has("record.update")).toBe(true);
  });

  it("EXCLUDES team/zone/server-scoped permissions (the core scoping fix)", () => {
    const sources: AbilitySource[] = [
      { permissions: ["record.update", "zone.delete"], scopeType: "team", scopeId: "team-a" },
      { permissions: ["record.create"], scopeType: "zone", scopeId: "zone-x" },
      { permissions: ["server.update"], scopeType: "server", scopeId: "srv-1" },
    ];
    const g = globalPermissionsOf(sources);
    expect(g.size).toBe(0);
    expect(g.has("record.update")).toBe(false);
    expect(g.has("zone.delete")).toBe(false);
    expect(g.has("server.update")).toBe(false);
  });

  it("unions global grants while ignoring scoped ones for the same permission", () => {
    const sources: AbilitySource[] = [
      { permissions: ["zone.read"], scopeType: "global", scopeId: null },
      { permissions: ["record.update"], scopeType: "team", scopeId: "team-a" },
    ];
    const g = globalPermissionsOf(sources);
    expect(g.has("zone.read")).toBe(true);
    expect(g.has("record.update")).toBe(false);
  });

  it("ignores scoped sources with a null scopeId", () => {
    const sources: AbilitySource[] = [
      { permissions: ["record.update"], scopeType: "team", scopeId: null },
    ];
    expect(globalPermissionsOf(sources).size).toBe(0);
  });
});

describe("permissionsExceedingGrant (the role-assign privilege ceiling)", () => {
  const actor = (perms: Permission[]): ReadonlySet<Permission> => new Set(perms);

  it("allows assigning a role within the actor's global permissions", () => {
    const exceeding = permissionsExceedingGrant(
      actor(["zone.read", "record.update", "role.assign"]),
      ["zone.read", "record.update"],
    );
    expect(exceeding).toEqual([]);
  });

  it("flags exactly the permissions the actor lacks (no SuperAdmin minting)", () => {
    const exceeding = permissionsExceedingGrant(actor(["role.assign", "zone.read"]), [
      "zone.read",
      "user.delete",
      "settings.write",
    ]);
    expect(exceeding).toEqual(["user.delete", "settings.write"]);
  });

  it("treats a scoped-only actor (empty global set) as able to grant nothing", () => {
    expect(permissionsExceedingGrant(actor([]), ["zone.read"])).toEqual(["zone.read"]);
  });
});

describe("buildAbility (documents the type-level CASL hazard this guards against)", () => {
  it("type-level can() returns TRUE for a team-scoped rule — why globalPermissionsOf exists", () => {
    const ability = buildAbility([
      { permissions: ["record.update"], scopeType: "team", scopeId: "team-a" },
    ]);
    // This is the footgun: the bare-string check can't see the condition.
    expect(ability.can("update", "Record")).toBe(true);
    // …but an instance check correctly honors the scope.
    expect(ability.can("update", { __type: "Record", zoneId: "z", teamId: "team-a" })).toBe(true);
    expect(ability.can("update", { __type: "Record", zoneId: "z", teamId: "team-b" })).toBe(false);
  });

  it("Team instance checks honor team scope (used by the team routes/pages)", () => {
    const ability = buildAbility([
      { permissions: ["team.manage-members"], scopeType: "team", scopeId: "team-a" },
    ]);
    expect(ability.can("manage-members", { __type: "Team", id: "team-a" })).toBe(true);
    expect(ability.can("manage-members", { __type: "Team", id: "team-b" })).toBe(false);
  });

  it("a global grant satisfies any instance check", () => {
    const ability = buildAbility([
      { permissions: ["team.manage-members"], scopeType: "global", scopeId: null },
    ]);
    expect(ability.can("manage-members", { __type: "Team", id: "anything" })).toBe(true);
  });
});
