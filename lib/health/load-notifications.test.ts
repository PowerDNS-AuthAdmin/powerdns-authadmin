import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repositories/backend-advisories", () => ({
  listActiveAdvisories: () => Promise.resolve([]),
}));

const { hasNotificationAudience, notificationViewerFor } = await import("./load-notifications");
const { canSeeAdvisory } = await import("./notifications");

type Access = Parameters<typeof notificationViewerFor>[0];

const access = (over: Partial<Access> = {}): Access => ({
  globalPermissions: new Set(),
  zoneGrants: [],
  zoneScopedPermissions: new Map(),
  ...over,
});

const monitorRow = (zone: string, backendId = "srv-a") => ({
  code: `monitor.${zone}.soa.mname`,
  backendId,
});
const backendRow = { code: "pdns.version.eol", backendId: "srv-a" };

describe("notification visibility for zone-scoped roles (ADR-0024)", () => {
  const scoped = access({
    zoneScopedPermissions: new Map([["example.com.", new Set(["zone.read"])]]),
  });

  it("gives a zone-scoped role an audience and its own zone's findings only", () => {
    expect(hasNotificationAudience(scoped)).toBe(true);
    const viewer = notificationViewerFor(scoped);
    expect(canSeeAdvisory(monitorRow("example.com."), viewer)).toBe(true);
    // Zone scopes carry no backend, so any backend's copy of the zone is in scope.
    expect(canSeeAdvisory(monitorRow("example.com.", "srv-b"), viewer)).toBe(true);
    expect(canSeeAdvisory(monitorRow("other.example."), viewer)).toBe(false);
    expect(canSeeAdvisory(backendRow, viewer)).toBe(false);
  });

  it("keeps a grant on its own backend", () => {
    const granted = access({
      zoneGrants: [
        {
          id: "g1",
          userId: "u1",
          teamId: null,
          createdBy: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          serverId: "srv-a",
          zoneName: "example.com.",
          permissions: ["zone.read"],
        },
      ],
    });
    const viewer = notificationViewerFor(granted);
    expect(canSeeAdvisory(monitorRow("example.com."), viewer)).toBe(true);
    expect(canSeeAdvisory(monitorRow("example.com.", "srv-b"), viewer)).toBe(false);
  });

  it("shows backend health only to a global server.read", () => {
    expect(canSeeAdvisory(backendRow, notificationViewerFor(access()))).toBe(false);
    const reader = access({ globalPermissions: new Set(["server.read"]) });
    expect(hasNotificationAudience(reader)).toBe(true);
    expect(canSeeAdvisory(backendRow, notificationViewerFor(reader))).toBe(true);
  });

  it("has no audience without server.read or zone.read anywhere", () => {
    expect(hasNotificationAudience(access())).toBe(false);
    expect(
      hasNotificationAudience(
        access({ zoneScopedPermissions: new Map([["example.com.", new Set(["record.read"])]]) }),
      ),
    ).toBe(false);
  });
});
