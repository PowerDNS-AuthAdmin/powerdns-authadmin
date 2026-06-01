import { describe, expect, it } from "vitest";
import {
  canActOnZone,
  effectiveZonePermissions,
  expandGrantsAcrossClusters,
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
    // practice, but the pure helper shouldn't care - defensive union.
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

describe("expandGrantsAcrossClusters", () => {
  const clusterGrant: ZoneGrantInput[] = [
    { serverId: "peer-1", zoneName: "example.com.", permissions: ["record.update"] },
  ];

  it("emits a copy of a cluster grant for every peer (preserving zone + permissions)", () => {
    const peers = new Map<string, readonly string[]>([["peer-1", ["peer-1", "peer-2", "peer-3"]]]);
    const out = expandGrantsAcrossClusters(clusterGrant, peers);
    expect(out.map((g) => g.serverId).sort()).toEqual(["peer-1", "peer-2", "peer-3"]);
    for (const g of out) {
      expect(g.zoneName).toBe("example.com.");
      expect(g.permissions).toEqual(["record.update"]);
    }
  });

  it("makes a cluster grant authorize the zone on a sibling peer (the #40 fix)", () => {
    const peers = new Map<string, readonly string[]>([["peer-1", ["peer-1", "peer-2"]]]);
    const expanded = expandGrantsAcrossClusters(clusterGrant, peers);
    // The request resolved peer-2 via choosePeer; the grant was issued on peer-1.
    expect(hasZonePermissionViaGrant(expanded, "peer-2", "example.com.", "record.update")).toBe(
      true,
    );
    // Without expansion the raw grant would NOT match peer-2.
    expect(hasZonePermissionViaGrant(clusterGrant, "peer-2", "example.com.", "record.update")).toBe(
      false,
    );
  });

  it("leaves a standalone grant (server absent from the map) untouched", () => {
    const out = expandGrantsAcrossClusters(clusterGrant, new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(clusterGrant[0]); // same reference, no copy
  });

  it("does not cross cluster boundaries", () => {
    const twoClusters: ZoneGrantInput[] = [
      { serverId: "a1", zoneName: "z.", permissions: ["zone.read"] },
      { serverId: "b1", zoneName: "z.", permissions: ["zone.delete"] },
    ];
    const peers = new Map<string, readonly string[]>([
      ["a1", ["a1", "a2"]],
      ["b1", ["b1", "b2"]],
    ]);
    const out = expandGrantsAcrossClusters(twoClusters, peers);
    // a-cluster peers only carry zone.read; b-cluster peers only zone.delete.
    expect(hasZonePermissionViaGrant(out, "a2", "z.", "zone.read")).toBe(true);
    expect(hasZonePermissionViaGrant(out, "a2", "z.", "zone.delete")).toBe(false);
    expect(hasZonePermissionViaGrant(out, "b2", "z.", "zone.delete")).toBe(true);
    expect(hasZonePermissionViaGrant(out, "b2", "z.", "zone.read")).toBe(false);
  });

  it("returns an empty array for empty input", () => {
    expect(expandGrantsAcrossClusters([], new Map())).toEqual([]);
  });
});
