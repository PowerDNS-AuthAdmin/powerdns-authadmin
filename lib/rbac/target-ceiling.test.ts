/**
 * lib/rbac/target-ceiling.test.ts
 *
 * Unit cover for the TARGET-privilege ceiling helper. The function is pure, so
 * these exercise its set-difference semantics directly; the route-level wiring
 * (reset-password, admin MFA removal) is covered by the integration suite.
 */

import { describe, expect, it } from "vitest";
import { permissionsTargetHoldsBeyondActor } from "./target-ceiling";

describe("permissionsTargetHoldsBeyondActor", () => {
  it("returns the permissions the target holds that the actor lacks", () => {
    const actor = new Set(["user.read", "user.reset-password"]);
    const target = new Set(["user.read", "user.delete", "settings.configure"]);
    expect(permissionsTargetHoldsBeyondActor(actor, target).sort()).toEqual([
      "settings.configure",
      "user.delete",
    ]);
  });

  it("returns [] when the target's permissions are a subset of the actor's", () => {
    const actor = new Set(["user.read", "user.delete", "user.reset-password"]);
    const target = new Set(["user.read"]);
    expect(permissionsTargetHoldsBeyondActor(actor, target)).toEqual([]);
  });

  it("returns [] when actor and target hold exactly the same permissions", () => {
    const perms = ["user.read", "user.update", "settings.configure"];
    expect(permissionsTargetHoldsBeyondActor(new Set(perms), new Set(perms))).toEqual([]);
  });

  it("returns [] for self-target (identical sets)", () => {
    const self = new Set(["user.reset-password", "user.update", "settings.configure"]);
    // Self-target passes the same set on both sides → never blocks the actor.
    expect(permissionsTargetHoldsBeyondActor(self, self)).toEqual([]);
  });

  it("returns [] when both sets are empty", () => {
    expect(permissionsTargetHoldsBeyondActor(new Set(), new Set())).toEqual([]);
  });

  it("returns every target permission when the actor holds none of them", () => {
    const actor = new Set<string>();
    const target = new Set(["user.delete", "role.assign"]);
    expect(permissionsTargetHoldsBeyondActor(actor, target).sort()).toEqual([
      "role.assign",
      "user.delete",
    ]);
  });
});
