import { describe, expect, it } from "vitest";
import { deriveCapabilities, summarizeCapabilities } from "./capabilities";
import type { PdnsConfigSetting } from "./types";

const cfg = (entries: Record<string, string>): PdnsConfigSetting[] =>
  Object.entries(entries).map(([name, value]) => ({ type: "ConfigSetting", name, value }));

describe("deriveCapabilities", () => {
  it("reads modern primary/secondary/autosecondary flags", () => {
    const caps = deriveCapabilities(
      cfg({ primary: "yes", secondary: "yes", autosecondary: "no", launch: "gsqlite3" }),
    );
    expect(caps.primary).toBe(true);
    expect(caps.secondary).toBe(true);
    expect(caps.autosecondary).toBe(false);
  });

  it("accepts legacy master/slave/superslave aliases", () => {
    const caps = deriveCapabilities(cfg({ master: "yes", slave: "yes", superslave: "yes" }));
    expect(caps.primary).toBe(true);
    expect(caps.secondary).toBe(true);
    expect(caps.autosecondary).toBe(true);
  });

  it("models a mixed primary+secondary daemon — the case role couldn't express", () => {
    const caps = deriveCapabilities(cfg({ primary: "yes", secondary: "yes" }));
    expect(caps.primary && caps.secondary).toBe(true);
  });

  it("parses launch into distinct backend names, stripping :instance suffixes", () => {
    const caps = deriveCapabilities(cfg({ launch: "gsqlite3:main, gsqlite3:other lmdb" }));
    expect(caps.backends).toEqual(["gsqlite3", "lmdb"]);
  });

  it("detects DNSSEC via <backend>-dnssec=yes", () => {
    expect(deriveCapabilities(cfg({ launch: "gsqlite3", "gsqlite3-dnssec": "yes" })).dnssec).toBe(
      true,
    );
    expect(deriveCapabilities(cfg({ launch: "gsqlite3", "gsqlite3-dnssec": "no" })).dnssec).toBe(
      false,
    );
  });

  it("treats lmdb as DNSSEC-capable without a flag", () => {
    expect(deriveCapabilities(cfg({ launch: "lmdb" })).dnssec).toBe(true);
  });

  it("assumes api=true when /config was readable but omits the flag", () => {
    expect(deriveCapabilities(cfg({ primary: "yes" })).api).toBe(true);
    expect(deriveCapabilities(cfg({ api: "no" })).api).toBe(false);
  });
});

describe("summarizeCapabilities", () => {
  it("shows the literal /config capability flags, verbatim", () => {
    expect(summarizeCapabilities(null)).toBe("unknown");
    expect(summarizeCapabilities(deriveCapabilities(cfg({ primary: "yes" })))).toBe("primary");
    expect(summarizeCapabilities(deriveCapabilities(cfg({ secondary: "yes" })))).toBe("secondary");
    // autosecondary is its own flag — never folded into "Secondary (auto)".
    expect(
      summarizeCapabilities(deriveCapabilities(cfg({ secondary: "yes", autosecondary: "yes" }))),
    ).toBe("secondary + autosecondary");
    expect(
      summarizeCapabilities(deriveCapabilities(cfg({ primary: "yes", secondary: "yes" }))),
    ).toBe("primary + secondary");
    // No replication flag set → falls back to the only capability that's on.
    expect(summarizeCapabilities(deriveCapabilities(cfg({ launch: "gsqlite3" })))).toBe("api");
  });
});
