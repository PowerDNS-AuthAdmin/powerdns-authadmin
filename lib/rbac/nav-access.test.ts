import { describe, expect, it } from "vitest";
import { navAccessOf, type NavAccessInput } from "./nav-access";
import { zoneScopedPermissionsOf } from "./zone-permissions";

function input(overrides: Partial<NavAccessInput> = {}): NavAccessInput {
  return {
    globalPermissions: new Set(),
    zoneGrants: [],
    zoneScopedPermissions: new Map(),
    canReadAnyTeam: false,
    features: { reverseDns: true, zoneMonitoring: true },
    ...overrides,
  };
}

describe("navAccessOf", () => {
  it("a user whose only role is scoped to one zone sees Zones and nothing admin-wide", () => {
    // Read Only scoped to a zone: before, every type-level check passed and the
    // nav offered Servers / Users / Roles / Settings, each of which refused.
    const nav = navAccessOf(
      input({
        zoneScopedPermissions: zoneScopedPermissionsOf([
          {
            scopeType: "zone",
            scopeId: "corp.example.",
            permissions: ["zone.read", "record.read", "user.read", "server.read", "settings.read"],
          },
        ]),
      }),
    );
    expect(nav.zones).toBe(true);
    const { zones: _zones, ...rest } = nav;
    expect(Object.values(rest).every((v) => v === false)).toBe(true);
  });

  it("a zone_grant opens the zones entry, matching the zones page guard", () => {
    const nav = navAccessOf(
      input({ zoneGrants: [{ serverId: "s", zoneName: "a.test.", permissions: ["zone.read"] }] }),
    );
    expect(nav.zones).toBe(true);
    expect(nav.importExport).toBe(false);
  });

  it("no access hides Zones", () => {
    expect(navAccessOf(input()).zones).toBe(false);
  });

  it("global permissions open their pages", () => {
    const nav = navAccessOf(
      input({
        globalPermissions: new Set(["zone.read", "server.read", "audit.read", "settings.read"]),
      }),
    );
    expect(nav.zones).toBe(true);
    expect(nav.zoneMonitoring).toBe(true);
    expect(nav.reverseDns).toBe(false);
    expect(nav.changeLog).toBe(true);
    expect(nav.importExport).toBe(true);
    expect(nav.servers).toBe(true);
    expect(nav.audit).toBe(true);
    expect(nav.requestLog).toBe(true);
    expect(nav.settings).toBe(true);
    expect(nav.users).toBe(false);
  });

  it("Reverse DNS and Zone Monitoring need global read and their feature switched on", () => {
    const globalRead = new Set(["zone.read", "record.read"]);
    const on = navAccessOf(input({ globalPermissions: globalRead }));
    expect(on.reverseDns).toBe(true);
    expect(on.zoneMonitoring).toBe(true);

    const off = navAccessOf(
      input({
        globalPermissions: globalRead,
        features: { reverseDns: false, zoneMonitoring: false },
      }),
    );
    expect(off.reverseDns).toBe(false);
    expect(off.zoneMonitoring).toBe(false);

    // A grant or zone-scoped role on one zone does not open the fleet-wide pages.
    const scoped = navAccessOf(
      input({
        zoneGrants: [
          { serverId: "s", zoneName: "a.test.", permissions: ["zone.read", "record.read"] },
        ],
        zoneScopedPermissions: zoneScopedPermissionsOf([
          { scopeType: "zone", scopeId: "b.test.", permissions: ["zone.read", "record.read"] },
        ]),
      }),
    );
    expect(scoped.reverseDns).toBe(false);
    expect(scoped.zoneMonitoring).toBe(false);
  });

  it("Add record opens for record.create held globally, by grant or by a zone-scoped role", () => {
    expect(navAccessOf(input()).addRecord).toBe(false);
    expect(navAccessOf(input({ globalPermissions: new Set(["record.create"]) })).addRecord).toBe(
      true,
    );
    expect(
      navAccessOf(
        input({
          zoneGrants: [{ serverId: "s", zoneName: "a.test.", permissions: ["record.create"] }],
        }),
      ).addRecord,
    ).toBe(true);
    expect(
      navAccessOf(
        input({
          zoneScopedPermissions: zoneScopedPermissionsOf([
            { scopeType: "zone", scopeId: "a.test.", permissions: ["record.create"] },
          ]),
        }),
      ).addRecord,
    ).toBe(true);
    // Read-only grant: no wizard.
    expect(
      navAccessOf(
        input({ zoneGrants: [{ serverId: "s", zoneName: "a.test.", permissions: ["zone.read"] }] }),
      ).addRecord,
    ).toBe(false);
  });

  it("the Change log follows global audit.read like the other logs", () => {
    expect(navAccessOf(input({ globalPermissions: new Set(["audit.read"]) })).changeLog).toBe(true);
    expect(navAccessOf(input()).changeLog).toBe(false);
  });

  it("Teams follows the any-instance check its page uses", () => {
    expect(navAccessOf(input({ canReadAnyTeam: true })).teams).toBe(true);
  });
});
