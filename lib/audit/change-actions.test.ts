import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_ACTIONS } from "./actions";
import {
  CHANGE_ACTIONS,
  CHANGE_CATEGORIES,
  CHANGE_ACTIONS_BY_CATEGORY,
  NOT_CHANGES,
  changeCategoryOf,
  zoneOfResource,
} from "./change-actions";

describe("change action classification", () => {
  it("classifies every audit action exactly once", () => {
    const classified = [...CHANGE_ACTIONS, ...NOT_CHANGES];
    const counts = new Map<string, number>();
    for (const a of classified) counts.set(a, (counts.get(a) ?? 0) + 1);
    const twice = [...counts].filter(([, n]) => n > 1).map(([a]) => a);
    expect(twice).toEqual([]);
    const missing = AUDIT_ACTIONS.filter((a) => !counts.has(a));
    expect(missing, "new audit action: add it to a category or NOT_CHANGES").toEqual([]);
    const unknown = classified.filter((a) => !(AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown, "classified action that is not in the vocabulary").toEqual([]);
  });

  it("never counts reads, reveals or sign-ins as changes", () => {
    for (const a of ["auth.login.success", "tsig.reveal", "zone.notify", "zone.export"]) {
      expect(changeCategoryOf(a)).toBeNull();
    }
    expect(changeCategoryOf("record.update")).toBe("records");
    expect(changeCategoryOf("auth.mfa.enrolled")).toBe("access");
    expect(changeCategoryOf("settings.write")).toBe("config");
    expect(CHANGE_CATEGORIES.every((c) => CHANGE_ACTIONS_BY_CATEGORY[c].length > 0)).toBe(true);
  });
});

describe("zoneOfResource", () => {
  it("reads the backend and zone from zone and rrset ids", () => {
    expect(zoneOfResource("zone", "standalone:example.com.")).toEqual({
      serverSlug: "standalone",
      zone: "example.com.",
    });
    expect(zoneOfResource("rrset", "peer-1:example.com.:www.example.com.|A")).toEqual({
      serverSlug: "peer-1",
      zone: "example.com.",
    });
  });

  it("returns null for other resources and malformed ids", () => {
    expect(zoneOfResource("user", "7c0a")).toBeNull();
    expect(zoneOfResource("zone", null)).toBeNull();
    expect(zoneOfResource("zone", ":example.com.")).toBeNull();
    expect(zoneOfResource("rrset", "slug:")).toBeNull();
  });
});
