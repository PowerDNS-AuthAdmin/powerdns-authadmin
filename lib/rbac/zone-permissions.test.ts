import { describe, expect, it } from "vitest";
import { globalPermissionsOf, type AbilitySource } from "./ability";
import { DEFAULT_ROLES } from "./default-roles";
import {
  canActOnZone,
  canListZones,
  canUseRecordWizard,
  effectiveZonePermissions,
  expandGrantsAcrossClusters,
  hasZonePermissionViaGrant,
  hasZoneScopedPermission,
  holdsOnSomeZone,
  isZoneScopablePermission,
  listableZoneFilter,
  zoneIsListable,
  zoneScopedPermissionsOf,
  type ZoneAccess,
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

/** A caller with no access at all; tests override the leg under test. */
function access(overrides: Partial<ZoneAccess> = {}): ZoneAccess {
  return {
    globalPermissions: new Set(),
    zoneGrants: [],
    zoneScopedPermissions: new Map(),
    ...overrides,
  };
}

const zoneEditor = DEFAULT_ROLES.find((r) => r.slug === "zone-editor")!.permissions;

/** The live failure: an IdP mapping `dns-corp → zone-editor @ zone:corp.example.` */
const scopedEditor = access({
  zoneScopedPermissions: zoneScopedPermissionsOf([
    { scopeType: "zone", scopeId: "corp.example.", permissions: zoneEditor },
  ]),
});

describe("canActOnZone - global and zone_grants legs (unchanged)", () => {
  it("returns true when the permission is held globally (grants not consulted)", () => {
    const a = access({ globalPermissions: new Set(["record.update"]) });
    expect(canActOnZone(a, { serverId: "s", zoneName: "z", permission: "record.update" })).toBe(
      true,
    );
  });

  it("falls through to grants when the permission is not held globally", () => {
    expect(
      canActOnZone(access({ zoneGrants: grants }), {
        serverId: "server-a",
        zoneName: "example.com.",
        permission: "record.update",
      }),
    ).toBe(true);
  });

  it("returns false when neither global nor a grant covers the permission", () => {
    expect(
      canActOnZone(access({ zoneGrants: grants }), {
        serverId: "server-a",
        zoneName: "example.com.",
        permission: "record.delete",
      }),
    ).toBe(false);
  });

  it("a grant for a DIFFERENT (server, zone) does not authorize this one", () => {
    // The core scoping property: holding record.update on server-a/example.com.
    // must NOT authorize the same action on server-b or another zone.
    const a = access({ zoneGrants: grants });
    expect(
      canActOnZone(a, {
        serverId: "server-b",
        zoneName: "example.com.",
        permission: "record.update",
      }),
    ).toBe(false);
    expect(
      canActOnZone(a, {
        serverId: "server-a",
        zoneName: "other.example.com.",
        permission: "record.update",
      }),
    ).toBe(false);
  });
});

describe("canActOnZone - zone-scoped roles (ADR-0024)", () => {
  it("a zone-scoped Zone Editor can read and edit records in its zone", () => {
    for (const permission of ["zone.read", "record.read", "record.create", "record.update"]) {
      expect(
        canActOnZone(scopedEditor, { serverId: "any", zoneName: "corp.example.", permission }),
      ).toBe(true);
    }
  });

  it("is denied on every other zone, including parents and children", () => {
    for (const zoneName of [
      "other.example.",
      "example.",
      "sub.corp.example.",
      "corp.example.evil.",
    ]) {
      expect(
        canActOnZone(scopedEditor, { serverId: "any", zoneName, permission: "record.update" }),
      ).toBe(false);
    }
  });

  it("keeps the role's own limits - Zone Editor gets no SOA, apex NS, settings or delete", () => {
    for (const permission of [
      "soa.update",
      "record.update.apex-ns",
      "zone.update",
      "zone.delete",
      "dnssec.configure",
    ]) {
      expect(
        canActOnZone(scopedEditor, { serverId: "any", zoneName: "corp.example.", permission }),
      ).toBe(false);
    }
  });

  it("matches the zone name on any backend (a zone scope carries no server)", () => {
    for (const serverId of ["server-a", "server-b", "cluster-peer-3"]) {
      expect(
        canActOnZone(scopedEditor, {
          serverId,
          zoneName: "corp.example.",
          permission: "record.update",
        }),
      ).toBe(true);
    }
  });

  it("canonicalises case and the trailing dot on both sides", () => {
    const a = access({
      zoneScopedPermissions: zoneScopedPermissionsOf([
        { scopeType: "zone", scopeId: " Corp.EXAMPLE ", permissions: ["record.update"] },
      ]),
    });
    for (const zoneName of ["corp.example.", "corp.example", "CORP.example."]) {
      expect(canActOnZone(a, { serverId: "s", zoneName, permission: "record.update" })).toBe(true);
    }
  });

  it("never grants zone.create, even if the role carries it", () => {
    const a = access({
      zoneScopedPermissions: zoneScopedPermissionsOf([
        { scopeType: "zone", scopeId: "corp.example.", permissions: ["zone.create", "zone.read"] },
      ]),
    });
    expect(
      canActOnZone(a, { serverId: "s", zoneName: "corp.example.", permission: "zone.create" }),
    ).toBe(false);
    // Defence in depth: even a hand-built map can't smuggle it through.
    const forged = access({
      zoneScopedPermissions: new Map([["corp.example.", new Set(["zone.create", "tsig.manage"])]]),
    });
    expect(
      canActOnZone(forged, { serverId: "s", zoneName: "corp.example.", permission: "zone.create" }),
    ).toBe(false);
    expect(
      canActOnZone(forged, { serverId: "s", zoneName: "corp.example.", permission: "tsig.manage" }),
    ).toBe(false);
  });

  it("unions all three sources", () => {
    const a = access({
      globalPermissions: new Set(["dnssec.read"]),
      zoneGrants: [{ serverId: "s1", zoneName: "corp.example.", permissions: ["metadata.read"] }],
      zoneScopedPermissions: zoneScopedPermissionsOf([
        { scopeType: "zone", scopeId: "corp.example.", permissions: ["record.update"] },
      ]),
    });
    for (const permission of ["dnssec.read", "metadata.read", "record.update"]) {
      expect(canActOnZone(a, { serverId: "s1", zoneName: "corp.example.", permission })).toBe(true);
    }
    // The grant leg stays server-pinned; the scoped leg does not.
    expect(
      canActOnZone(a, { serverId: "s2", zoneName: "corp.example.", permission: "metadata.read" }),
    ).toBe(false);
    expect(
      canActOnZone(a, { serverId: "s2", zoneName: "corp.example.", permission: "record.update" }),
    ).toBe(true);
  });
});

describe("zoneScopedPermissionsOf", () => {
  it("keeps only zone scopes and only zone-bound permissions", () => {
    const map = zoneScopedPermissionsOf([
      { scopeType: "global", scopeId: null, permissions: ["record.update"] },
      { scopeType: "team", scopeId: "team-1", permissions: ["record.update"] },
      { scopeType: "server", scopeId: "server-1", permissions: ["record.update"] },
      { scopeType: "zone", scopeId: null, permissions: ["record.update"] },
      { scopeType: "zone", scopeId: "", permissions: ["record.update"] },
      {
        scopeType: "zone",
        scopeId: "corp.example.",
        permissions: ["record.read", "user.read", "audit.read", "server.read", "tsig.read"],
      },
    ]);
    expect([...map.keys()]).toEqual(["corp.example."]);
    expect(map.get("corp.example.")).toEqual(new Set(["record.read"]));
  });

  it("merges several assignments on the same zone (admin + IdP)", () => {
    const map = zoneScopedPermissionsOf([
      { scopeType: "zone", scopeId: "corp.example.", permissions: ["zone.read"] },
      { scopeType: "zone", scopeId: "CORP.EXAMPLE", permissions: ["record.update"] },
    ]);
    expect(map.get("corp.example.")).toEqual(new Set(["zone.read", "record.update"]));
  });

  it("never feeds the global set - a zone-scoped role can't pass a global gate", () => {
    // Zone Editor carries token.create.own and Read Only carries user.read,
    // server.read, …: scoped to a zone, none of that may surface globally.
    const readOnly = DEFAULT_ROLES.find((r) => r.slug === "read-only")!.permissions;
    const sources: AbilitySource[] = [
      { scopeType: "zone", scopeId: "corp.example.", permissions: [...zoneEditor, ...readOnly] },
    ];
    expect(globalPermissionsOf(sources).size).toBe(0);
    const scoped = zoneScopedPermissionsOf(sources).get("corp.example.")!;
    for (const p of ["user.read", "server.read", "settings.read", "token.create.own"]) {
      expect(scoped.has(p)).toBe(false);
    }
  });
});

describe("isZoneScopablePermission", () => {
  it("accepts zone-bound actions and rejects zone.create, TSIG and non-zone subjects", () => {
    for (const p of ["zone.read", "zone.delete", "record.update.apex-ns", "soa.update"]) {
      expect(isZoneScopablePermission(p)).toBe(true);
    }
    for (const p of ["zone.create", "tsig.manage", "user.read", "server.read"]) {
      expect(isZoneScopablePermission(p)).toBe(false);
    }
  });
});

describe("listableZoneFilter / canListZones", () => {
  it("global zone.read lists everything", () => {
    const a = access({ globalPermissions: new Set(["zone.read"]) });
    expect(listableZoneFilter(a)).toEqual({ all: true });
    expect(canListZones(a)).toBe(true);
  });

  it("a zone-scoped role lists only its zone", () => {
    const filter = listableZoneFilter(scopedEditor);
    expect(zoneIsListable(filter, "corp.example.")).toBe(true);
    expect(zoneIsListable(filter, "CORP.EXAMPLE")).toBe(true);
    expect(zoneIsListable(filter, "other.test.")).toBe(false);
    expect(canListZones(scopedEditor)).toBe(true);
  });

  it("a zone-scoped role without zone.read doesn't list the zone", () => {
    const a = access({
      zoneScopedPermissions: zoneScopedPermissionsOf([
        { scopeType: "zone", scopeId: "corp.example.", permissions: ["record.update"] },
      ]),
    });
    expect(canListZones(a)).toBe(false);
  });

  it("zone_grants keep listing their zones as before (any permission)", () => {
    const a = access({ zoneGrants: grants });
    const filter = listableZoneFilter(a);
    expect(zoneIsListable(filter, "example.com.")).toBe(true);
    expect(zoneIsListable(filter, "other.example.com.")).toBe(true);
    expect(zoneIsListable(filter, "corp.example.")).toBe(false);
  });

  it("no access lists nothing", () => {
    expect(canListZones(access())).toBe(false);
    // Non-zone global permissions don't open the zones list.
    expect(canListZones(access({ globalPermissions: new Set(["user.read"]) }))).toBe(false);
  });
});

describe("holdsOnSomeZone", () => {
  const isRecord = (p: string) => p.startsWith("record.");
  it("sees grants and zone-scoped roles", () => {
    expect(holdsOnSomeZone(access({ zoneGrants: grants }), isRecord)).toBe(true);
    expect(holdsOnSomeZone(scopedEditor, isRecord)).toBe(true);
    expect(holdsOnSomeZone(access(), isRecord)).toBe(false);
  });
});

describe("hasZoneScopedPermission", () => {
  it("answers by zone name alone", () => {
    expect(hasZoneScopedPermission(scopedEditor, "corp.example", "zone.read")).toBe(true);
    expect(hasZoneScopedPermission(scopedEditor, "other.test.", "zone.read")).toBe(false);
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

describe("canUseRecordWizard", () => {
  const access = (over: Partial<ZoneAccess>): ZoneAccess => ({
    globalPermissions: new Set(),
    zoneGrants: [],
    zoneScopedPermissions: new Map(),
    ...over,
  });

  it("admits global record.create, a grant or a zone-scoped role carrying it", () => {
    expect(canUseRecordWizard(access({ globalPermissions: new Set(["record.create"]) }))).toBe(
      true,
    );
    expect(
      canUseRecordWizard(
        access({
          zoneGrants: [{ serverId: "s", zoneName: "example.com.", permissions: ["record.create"] }],
        }),
      ),
    ).toBe(true);
    expect(
      canUseRecordWizard(
        access({ zoneScopedPermissions: new Map([["example.com.", new Set(["record.create"])]]) }),
      ),
    ).toBe(true);
  });

  it("refuses read-only access", () => {
    expect(canUseRecordWizard(access({}))).toBe(false);
    expect(
      canUseRecordWizard(
        access({
          globalPermissions: new Set(["record.read"]),
          zoneScopedPermissions: new Map([["example.com.", new Set(["record.update"])]]),
        }),
      ),
    ).toBe(false);
  });
});
