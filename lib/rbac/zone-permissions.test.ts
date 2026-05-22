import { describe, expect, it } from "vitest";
import {
  canActOnZone,
  effectiveZonePermissions,
  hasZonePermissionViaGrant,
  type ZoneGrantInput,
} from "./zone-permissions";

const grants: ZoneGrantInput[] = [
  {
    serverId: "server-a",
    zoneName: "example.com.",
    permissions: ["zone.read", "record.read", "record.update"],
  },
  {
    serverId: "server-a",
    zoneName: "other.example.com.",
    permissions: ["zone.read"],
  },
  {
    serverId: "server-b",
    zoneName: "example.com.",
    permissions: ["zone.read", "zone.delete"],
  },
];

describe("effectiveZonePermissions", () => {
  it("returns the permissions for an exact (server, zone) match", () => {
    const result = effectiveZonePermissions(grants, "server-a", "example.com.");
    expect(result).toEqual(new Set(["zone.read", "record.read", "record.update"]));
  });

  it("differentiates by serverId", () => {
    const a = effectiveZonePermissions(grants, "server-a", "example.com.");
    const b = effectiveZonePermissions(grants, "server-b", "example.com.");
    expect(a).not.toEqual(b);
    expect(b.has("zone.delete")).toBe(true);
    expect(a.has("zone.delete")).toBe(false);
  });

  it("returns empty set when no grant matches", () => {
    expect(effectiveZonePermissions(grants, "server-a", "missing.zone.")).toEqual(new Set());
    expect(effectiveZonePermissions(grants, "server-c", "example.com.")).toEqual(new Set());
  });

  it("returns empty set on empty input", () => {
    expect(effectiveZonePermissions([], "server-a", "example.com.")).toEqual(new Set());
  });

  it("unions across multiple matching grants (unusual but defensible)", () => {
    // Same (user, server, zone) is forbidden by the unique index in
    // practice, but the pure helper shouldn't care — defensive union.
    const dup: ZoneGrantInput[] = [
      { serverId: "s", zoneName: "z.", permissions: ["a"] },
      { serverId: "s", zoneName: "z.", permissions: ["b"] },
    ];
    expect(effectiveZonePermissions(dup, "s", "z.")).toEqual(new Set(["a", "b"]));
  });

  it("matches zone names case-sensitively (callers must canonicalize)", () => {
    expect(effectiveZonePermissions(grants, "server-a", "EXAMPLE.COM.")).toEqual(new Set());
  });
});

describe("hasZonePermissionViaGrant", () => {
  it("returns true when the permission is present", () => {
    expect(hasZonePermissionViaGrant(grants, "server-a", "example.com.", "record.update")).toBe(
      true,
    );
  });

  it("returns false when the permission is absent", () => {
    expect(hasZonePermissionViaGrant(grants, "server-a", "example.com.", "record.delete")).toBe(
      false,
    );
  });

  it("returns false when no grant matches the (server, zone)", () => {
    expect(hasZonePermissionViaGrant(grants, "server-c", "example.com.", "zone.read")).toBe(false);
  });

  it("returns false on empty grant list", () => {
    expect(hasZonePermissionViaGrant([], "s", "z", "any.thing")).toBe(false);
  });
});

describe("canActOnZone", () => {
  it("returns true when the permission is held globally (grants not consulted)", () => {
    expect(
      canActOnZone({
        hasGlobalPermission: true,
        grants: [],
        serverId: "s",
        zoneName: "z",
        permission: "record.update",
      }),
    ).toBe(true);
  });

  it("falls through to grants when the permission is not held globally", () => {
    expect(
      canActOnZone({
        hasGlobalPermission: false,
        grants,
        serverId: "server-a",
        zoneName: "example.com.",
        permission: "record.update",
      }),
    ).toBe(true);
  });

  it("returns false when neither global nor a grant covers the permission", () => {
    expect(
      canActOnZone({
        hasGlobalPermission: false,
        grants,
        serverId: "server-a",
        zoneName: "example.com.",
        permission: "record.delete",
      }),
    ).toBe(false);
  });

  it("a grant for a DIFFERENT (server, zone) does not authorize this one", () => {
    // The core scoping property: holding record.update on server-a/example.com.
    // must NOT authorize the same action on server-b or another zone.
    expect(
      canActOnZone({
        hasGlobalPermission: false,
        grants,
        serverId: "server-b",
        zoneName: "example.com.",
        permission: "record.update",
      }),
    ).toBe(false);
    expect(
      canActOnZone({
        hasGlobalPermission: false,
        grants,
        serverId: "server-a",
        zoneName: "other.example.com.",
        permission: "record.update",
      }),
    ).toBe(false);
  });
});
