import { describe, expect, it } from "vitest";
import { safeConfigSettings } from "./config-advice";
import type { PdnsConfigSetting } from "./types";

const cfg = (entries: Record<string, string>): PdnsConfigSetting[] =>
  Object.entries(entries).map(([name, value]) => ({ type: "ConfigSetting", name, value }));

describe("safeConfigSettings", () => {
  it("shows allowlisted operational settings and redacts secrets", () => {
    const rows = safeConfigSettings(
      cfg({
        "api-key": "super-secret",
        "gmysql-password": "hunter2",
        primary: "yes",
        secondary: "no",
        "allow-axfr-ips": "10.0.0.0/8",
        launch: "gsqlite3",
      }),
    );
    const byName = new Map(rows.map((r) => [r.name, r.value]));
    // api-key is allowlisted so the operator sees the setting exists - but redacted.
    expect(byName.get("api-key")).toBe("<redacted>");
    // Non-allowlisted secrets (gmysql-password) don't appear at all.
    expect(byName.has("gmysql-password")).toBe(false);
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["primary", "secondary", "allow-axfr-ips", "launch"]),
    );
    // No secret values leak into the displayed rows.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("hunter2");
  });

  it("omits settings that aren't present or are empty", () => {
    expect(safeConfigSettings(cfg({ primary: "yes", secondary: "" }))).toEqual([
      { name: "primary", value: "yes" },
    ]);
  });
});
