import { describe, expect, it } from "vitest";
import type { AppNotification, NotificationGroup } from "@/lib/health/notifications";
import {
  badgeCount,
  bellLabel,
  entryView,
  groupScope,
  groupZoneSample,
  summaryLine,
} from "./notification-format";

const s = (over: Partial<Parameters<typeof summaryLine>[0]>) => ({
  active: 0,
  error: 0,
  warn: 0,
  info: 0,
  dismissed: 0,
  ...over,
});

describe("notification format", () => {
  it("summarises by severity with correct plurals", () => {
    expect(summaryLine(s({ active: 3, error: 1, warn: 2 }))).toBe("1 error, 2 warnings");
    expect(summaryLine(s({ active: 1, info: 1 }))).toBe("1 notice");
    expect(summaryLine(s({}))).toBe("");
  });

  it("caps the badge at 99+", () => {
    expect(badgeCount(7)).toBe("7");
    expect(badgeCount(120)).toBe("99+");
  });

  it("names the bell with its count", () => {
    expect(bellLabel(s({}))).toBe("Notifications: none active");
    expect(bellLabel(s({ active: 4, error: 1 }))).toBe("Notifications: 4 active, 1 error");
  });
});

describe("grouped findings", () => {
  const member = (zone: string, backendId = "srv-a"): AppNotification => ({
    id: `${backendId}-${zone}`,
    severity: "warn",
    source: "zone",
    title: `${zone} SOA MNAME is not one of the nameservers`,
    detail: "d",
    backendId,
    backendName: backendId,
    backendSlug: backendId,
    zone,
    finding: "soa.mname",
    href: "/zones/monitoring",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    acknowledged: false,
  });

  it("names the first few zones once each and counts the rest", () => {
    expect(groupZoneSample(["a.", "b."])).toBe("a., b.");
    expect(groupZoneSample(["a.", "b.", "a.", "c.", "d.", "e."])).toBe("a., b., c. and 2 more");
  });

  it("counts zones, and backends only when there is more than one", () => {
    expect(groupScope([member("a."), member("b.")])).toBe("2 zones");
    expect(groupScope([member("a."), member("a.", "srv-b"), member("b.")])).toBe(
      "2 zones on 2 backends",
    );
  });

  it("views a group as one row with its count and fix link", () => {
    const group: NotificationGroup = {
      kind: "group",
      key: "soa.mname|warn|active",
      severity: "warn",
      finding: "soa.mname",
      title: "SOA MNAME is not one of the nameservers",
      members: [member("a."), member("b.")],
      href: "/zones/monitoring",
      fixHref: "/zones/monitoring?fix=soa.mname",
      lastSeenAt: "2026-01-01T00:01:00.000Z",
      acknowledged: false,
    };
    expect(entryView(group)).toMatchObject({
      key: "soa.mname|warn|active",
      title: "SOA MNAME is not one of the nameservers, 2 zones",
      detail: "a., b.",
      fixHref: "/zones/monitoring?fix=soa.mname",
      backendName: null,
    });
    expect(entryView({ kind: "single", notification: member("a.") })).toMatchObject({
      key: "srv-a-a.",
      source: "Zone monitoring",
      backendName: "srv-a",
      fixHref: null,
    });
  });
});
