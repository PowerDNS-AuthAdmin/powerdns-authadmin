import { describe, expect, it } from "vitest";
import { DRIFT_THRESHOLD_MS, evaluateBackendHealth } from "./evaluator";
import type { PdnsDaemonCapabilities } from "@/lib/pdns/types";

const caps = (over: Partial<PdnsDaemonCapabilities>): PdnsDaemonCapabilities => ({
  api: true,
  primary: false,
  secondary: false,
  autosecondary: false,
  backends: ["gsqlite3"],
  dnssec: false,
  fetchedAt: new Date().toISOString(),
  ...over,
});

describe("evaluateBackendHealth", () => {
  it("flags ONLY unreachable when the backend can't be reached (no stale capability noise)", () => {
    const out = evaluateBackendHealth({
      reachable: false,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 5 },
    });
    expect(out.map((a) => a.code)).toEqual(["backend.unreachable"]);
    expect(out[0]!.severity).toBe("error");
  });

  it("says nothing for an unprobed backend (no capability snapshot yet)", () => {
    expect(
      evaluateBackendHealth({ reachable: true, capabilities: null, zoneKinds: { slave: 3 } }),
    ).toEqual([]);
  });

  it("errors when it holds secondary zones but secondary=no", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ secondary: false }),
      zoneKinds: { Slave: 0, slave: 4 },
    });
    expect(out.map((a) => a.code)).toContain("secondary.cant-axfr");
    expect(out.find((a) => a.code === "secondary.cant-axfr")!.severity).toBe("error");
  });

  it("does NOT error when secondary zones exist and secondary=yes", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 4 },
    });
    expect(out.map((a) => a.code)).not.toContain("secondary.cant-axfr");
  });

  it("warns when it serves primary zones but primary=no", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ primary: false }),
      zoneKinds: { master: 2 },
    });
    const a = out.find((x) => x.code === "primary.no-notify");
    expect(a?.severity).toBe("warn");
  });

  it("is silent for a correctly-configured mixed primary+secondary daemon", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ primary: true, secondary: true, autoprimaryCount: 0 }),
      zoneKinds: { master: 3, slave: 2, native: 5 },
    });
    expect(out).toEqual([]);
  });

  it("flags an API-auth error distinctly from a plain unreachable", () => {
    const out = evaluateBackendHealth({
      reachable: false,
      authError: true,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 1 },
    });
    expect(out.map((a) => a.code)).toEqual(["backend.api-auth"]);
    expect(out[0]!.severity).toBe("error");
  });

  it("errors when a mirror zone has no masters[]", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 2 },
      mirrorZonesWithoutMasters: 1,
    });
    const a = out.find((x) => x.code === "secondary.no-masters");
    expect(a?.severity).toBe("error");
  });

  it("reports drift only past the threshold (transient lag is ignored)", () => {
    const base = {
      reachable: true as const,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 1 },
    };
    expect(
      evaluateBackendHealth({ ...base, replicationDriftMs: DRIFT_THRESHOLD_MS - 1 }).map(
        (a) => a.code,
      ),
    ).not.toContain("replication.drift");
    expect(
      evaluateBackendHealth({ ...base, replicationDriftMs: DRIFT_THRESHOLD_MS }).map((a) => a.code),
    ).toContain("replication.drift");
  });

  it("flags a secondary missing replicated TSIG keys (error)", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 2 },
      missingTransferKeys: 1,
    });
    const a = out.find((x) => x.code === "secondary.missing-tsig-key");
    expect(a?.severity).toBe("error");
  });

  it("does not flag missing TSIG keys when none are missing", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ secondary: true }),
      zoneKinds: { slave: 2 },
      missingTransferKeys: 0,
    });
    expect(out.map((a) => a.code)).not.toContain("secondary.missing-tsig-key");
  });

  it("warns on autosecondary=yes with zero autoprimaries", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ autosecondary: true, autoprimaryCount: 0 }),
      zoneKinds: {},
    });
    const a = out.find((x) => x.code === "autosecondary.no-autoprimaries");
    expect(a?.severity).toBe("warn");
  });

  it("warns on configured autoprimaries with autosecondary=no", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ autosecondary: false, autoprimaryCount: 2 }),
      zoneKinds: {},
    });
    expect(out.map((a) => a.code)).toContain("autosecondary.disabled-with-autoprimaries");
  });

  it("skips the autosecondary rule when the autoprimary count is unobserved", () => {
    const out = evaluateBackendHealth({
      reachable: true,
      capabilities: caps({ autosecondary: true }),
      zoneKinds: {},
    });
    expect(out.map((a) => a.code)).not.toContain("autosecondary.no-autoprimaries");
  });
});
