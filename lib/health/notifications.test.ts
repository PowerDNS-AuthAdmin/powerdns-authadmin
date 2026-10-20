import { describe, expect, it } from "vitest";
import {
  bellPreview,
  canSeeAdvisory,
  monitorZoneOf,
  summarizeNotifications,
  visibleNotifications,
  type AdvisoryRow,
  type NotificationViewer,
} from "./notifications";

const at = (m: number): Date => new Date(Date.UTC(2026, 0, 1, 0, m));

function row(over: Partial<AdvisoryRow>): AdvisoryRow {
  return {
    id: "id",
    backendId: "srv-a",
    backendName: "Primary",
    backendSlug: "primary",
    code: "pdns.unreachable",
    severity: "warn",
    title: "t",
    detail: "d",
    firstSeenAt: at(0),
    lastSeenAt: at(1),
    acknowledgedAt: null,
    ...over,
  };
}

const nobody: NotificationViewer = {
  canReadServers: false,
  globalZoneRead: false,
  canReadZone: () => false,
};

describe("monitorZoneOf", () => {
  it("splits the zone from the finding code at the first double dot", () => {
    expect(monitorZoneOf("monitor.example.com..soa.mname")).toBe("example.com.");
    expect(monitorZoneOf("monitor.2.0.192.in-addr.arpa..nameserver.count")).toBe(
      "2.0.192.in-addr.arpa.",
    );
    expect(monitorZoneOf("monitor...delegation.missing")).toBe(".");
  });

  it("returns null for backend codes and malformed monitor codes", () => {
    expect(monitorZoneOf("pdns.unreachable")).toBeNull();
    expect(monitorZoneOf("monitor.nodots")).toBeNull();
  });
});

describe("canSeeAdvisory", () => {
  it("needs server.read for backend health", () => {
    expect(canSeeAdvisory(row({}), nobody)).toBe(false);
    expect(canSeeAdvisory(row({}), { ...nobody, canReadServers: true })).toBe(true);
  });

  it("needs zone.read on that zone and backend for a monitoring finding", () => {
    const granted: NotificationViewer = {
      ...nobody,
      canReadZone: (serverId, zone) => serverId === "srv-a" && zone === "mine.example.",
    };
    expect(canSeeAdvisory(row({ code: "monitor.mine.example..soa.mname" }), granted)).toBe(true);
    expect(canSeeAdvisory(row({ code: "monitor.other.example..soa.mname" }), granted)).toBe(false);
    expect(
      canSeeAdvisory(row({ code: "monitor.mine.example..soa.mname", backendId: "srv-b" }), granted),
    ).toBe(false);
    // server.read alone does not reveal zone findings.
    expect(
      canSeeAdvisory(row({ code: "monitor.other.example..soa.mname" }), {
        ...nobody,
        canReadServers: true,
      }),
    ).toBe(false);
  });

  it("falls back to global zone.read when the zone cannot be parsed", () => {
    expect(canSeeAdvisory(row({ code: "monitor.broken" }), nobody)).toBe(false);
    expect(
      canSeeAdvisory(row({ code: "monitor.broken" }), { ...nobody, globalZoneRead: true }),
    ).toBe(true);
  });
});

describe("visibleNotifications, summary and bell preview", () => {
  const everyone: NotificationViewer = {
    canReadServers: true,
    globalZoneRead: true,
    canReadZone: () => true,
  };
  const rows = [
    row({ id: "w-old", severity: "warn", lastSeenAt: at(1) }),
    row({ id: "w-new", severity: "warn", lastSeenAt: at(5) }),
    row({ id: "e", severity: "error", lastSeenAt: at(0) }),
    row({ id: "acked", severity: "error", acknowledgedAt: at(3) }),
    row({ id: "z", code: "monitor.example.com..soa.mname", severity: "warn", lastSeenAt: at(2) }),
    row({ id: "i", severity: "info" }),
  ];

  it("orders active before dismissed, errors first, newest first", () => {
    expect(visibleNotifications(rows, everyone).map((n) => n.id)).toEqual([
      "e",
      "w-new",
      "z",
      "w-old",
      "i",
      "acked",
    ]);
  });

  it("labels the source and links each to where it is fixed", () => {
    const list = visibleNotifications(rows, everyone);
    const zone = list.find((n) => n.id === "z")!;
    expect(zone).toMatchObject({ source: "zone", zone: "example.com.", href: "/zones/monitoring" });
    expect(list.find((n) => n.id === "e")).toMatchObject({
      source: "backend",
      zone: null,
      href: "/admin/servers/srv-a",
    });
  });

  it("counts and previews only what is active", () => {
    const list = visibleNotifications(rows, everyone);
    expect(summarizeNotifications(list)).toEqual({
      active: 5,
      error: 1,
      warn: 3,
      info: 1,
      dismissed: 1,
    });
    expect(bellPreview(list).map((n) => n.id)).toEqual(["e", "w-new", "z"]);
  });
});
