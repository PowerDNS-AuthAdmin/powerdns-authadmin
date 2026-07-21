import { describe, expect, it } from "vitest";
import {
  deriveCapabilities,
  isReadOnlyMirror,
  isWriteCapable,
  isServerWriteTarget,
  isReadOnlyBackend,
  classifyGroup,
  summarizeCapabilities,
} from "./capabilities";
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

  it("models a mixed primary+secondary daemon - the case role couldn't express", () => {
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
    // autosecondary is its own flag - never folded into "Secondary (auto)".
    expect(
      summarizeCapabilities(deriveCapabilities(cfg({ secondary: "yes", autosecondary: "yes" }))),
    ).toBe("secondary + autosecondary");
    expect(
      summarizeCapabilities(deriveCapabilities(cfg({ primary: "yes", secondary: "yes" }))),
    ).toBe("primary + secondary");
    // No replication flag set → standalone (#57): API hosts zones, no AXFR.
    expect(summarizeCapabilities(deriveCapabilities(cfg({ launch: "gsqlite3" })))).toBe(
      "standalone",
    );
    // API reported off → unreachable (we couldn't actually have read /config in
    // that case, but the predicate has to be total).
    expect(summarizeCapabilities(deriveCapabilities(cfg({ api: "no" })))).toBe("unreachable");
  });
});

// #57 - A standalone PDNS Auth (no `primary` / `secondary` in pdns.conf) is the
// default config and accepts zone creates over the HTTP API. The old
// `isWriteCapable` checked `caps.primary` directly and so excluded standalones
// from /zones/new's backend picker. Pin the four-way matrix here so it stays
// fixed.
describe("isWriteCapable / isReadOnlyMirror", () => {
  it.each<[string, Record<string, string>, boolean, boolean]>([
    ["standalone (no flags)", {}, true, false],
    ["primary only", { primary: "yes" }, true, false],
    ["secondary only", { secondary: "yes" }, false, true],
    ["dual-role primary+secondary", { primary: "yes", secondary: "yes" }, true, false],
  ])("%s → write=%s, mirror=%s", (_label, flags, writeExpected, mirrorExpected) => {
    const caps = deriveCapabilities(cfg(flags));
    expect(isWriteCapable(caps)).toBe(writeExpected);
    expect(isReadOnlyMirror(caps)).toBe(mirrorExpected);
  });

  it("treats unprobed (null) as write-capable so newly-added backends are usable", () => {
    expect(isWriteCapable(null)).toBe(true);
    expect(isWriteCapable(undefined)).toBe(true);
    expect(isReadOnlyMirror(null)).toBe(false);
  });
});

// The #109 case: a public nameserver serving native zones, fed by database
// replication, whose DB user is read-only. Over /config it is indistinguishable
// from a standalone primary, so only the operator's override can keep writes
// off it.
describe("isServerWriteTarget / isReadOnlyBackend (write_mode override)", () => {
  const standalone = deriveCapabilities(cfg({}));
  const mirror = deriveCapabilities(cfg({ secondary: "yes" }));

  it("routes writes to a standalone backend on the default write_mode", () => {
    expect(isServerWriteTarget({ capabilities: standalone, writeMode: "auto" })).toBe(true);
    expect(isReadOnlyBackend({ capabilities: standalone, writeMode: "auto" })).toBe(false);
  });

  it("vetoes writes to a standalone backend marked read_only", () => {
    expect(isServerWriteTarget({ capabilities: standalone, writeMode: "read_only" })).toBe(false);
    expect(isReadOnlyBackend({ capabilities: standalone, writeMode: "read_only" })).toBe(true);
  });

  it("vetoes writes to an unprobed backend marked read_only", () => {
    // Otherwise the "unprobed defaults to writable" rule would punch straight
    // through the override during the window before the first probe.
    expect(isServerWriteTarget({ capabilities: null, writeMode: "read_only" })).toBe(false);
    expect(isServerWriteTarget({ capabilities: null, writeMode: "auto" })).toBe(true);
  });

  it("never promotes an observed mirror into a write target", () => {
    // The override can only subtract. `auto` on a mirror stays read-only.
    expect(isServerWriteTarget({ capabilities: mirror, writeMode: "auto" })).toBe(false);
    expect(isServerWriteTarget({ capabilities: mirror, writeMode: "read_only" })).toBe(false);
  });
});

describe("classifyGroup with write_mode overrides", () => {
  const standalone = deriveCapabilities(cfg({}));

  it("counts read_only members as mirrors, not writable peers", () => {
    // One hidden primary + three read-only public nameservers. All four look
    // writable over /config; only the override reveals the real shape.
    const g = classifyGroup([
      { capabilities: standalone, writeMode: "auto" },
      { capabilities: standalone, writeMode: "read_only" },
      { capabilities: standalone, writeMode: "read_only" },
      { capabilities: standalone, writeMode: "read_only" },
    ]);
    expect(g.writable).toBe(1);
    expect(g.mirrors).toBe(3);
    // Crucially NOT "Multi-primary cluster" - there is exactly one write
    // target, so a peer-selection strategy would have nothing to choose from.
    expect(g.isMultiPrimary).toBe(false);
    expect(g.typeLabel).toBe("Primary + secondaries");
  });

  it("still reports a genuine multi-primary cluster when no override is set", () => {
    const g = classifyGroup([
      { capabilities: standalone, writeMode: "auto" },
      { capabilities: standalone, writeMode: "auto" },
    ]);
    expect(g.isMultiPrimary).toBe(true);
    expect(g.typeLabel).toBe("Multi-primary cluster");
  });
});
