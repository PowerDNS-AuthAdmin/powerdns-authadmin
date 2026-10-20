import { describe, expect, it } from "vitest";
import { badgeCount, bellLabel, summaryLine } from "./notification-format";

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
