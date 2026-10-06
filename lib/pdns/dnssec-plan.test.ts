import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNED_SOA_EDIT,
  bumpSoaSerial,
  dsRecordsToPublish,
  isTransferredKind,
  planDnssecEnable,
  sameZoneName,
  signedZoneWarnings,
} from "./dnssec-plan";

describe("planDnssecEnable", () => {
  it("transferred zone without SOA-EDIT gets INCREMENT-WEEKS + API-RECTIFY", () => {
    const plan = planDnssecEnable({ kind: "Master", soa_edit: "" }, true);
    expect(plan.settings).toEqual({
      dnssec: true,
      api_rectify: true,
      soa_edit: DEFAULT_SIGNED_SOA_EDIT,
    });
    expect(plan.replicated).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("Master kind counts as replicated even with no managed mirror", () => {
    const plan = planDnssecEnable({ kind: "Master", soa_edit: "" }, false);
    expect(plan.settings.soa_edit).toBe(DEFAULT_SIGNED_SOA_EDIT);
  });

  it("Native zone without mirrors: no SOA-EDIT change", () => {
    const plan = planDnssecEnable({ kind: "Native", soa_edit: "" }, false);
    expect(plan.settings).toEqual({ dnssec: true, api_rectify: true });
    expect(plan.replicated).toBe(false);
  });

  it("keeps an existing SOA-EDIT", () => {
    const plan = planDnssecEnable({ kind: "Master", soa_edit: "INCEPTION-INCREMENT" }, true);
    expect(plan.settings.soa_edit).toBeUndefined();
  });

  it("explicit choices win, and an explicit '' on a replicated zone warns", () => {
    const plan = planDnssecEnable({ kind: "Master", soa_edit: "" }, true, {
      soaEdit: "",
      apiRectify: false,
      nsec3param: "1 0 0 -",
    });
    expect(plan.settings).toEqual({ dnssec: true, api_rectify: false, nsec3param: "1 0 0 -" });
    expect(plan.warnings.join(" ")).toMatch(/SOA-EDIT is not set/);
    expect(plan.warnings.join(" ")).toMatch(/API-RECTIFY is off/);
  });
});

describe("signedZoneWarnings", () => {
  it("flags LUA and ALIAS on a replicated zone only", () => {
    const zone = {
      kind: "Master",
      soa_edit: "INCREMENT-WEEKS",
      rrsets: [{ type: "LUA" }, { type: "ALIAS" }, { type: "A" }],
    };
    const replicated = signedZoneWarnings(zone, true).join(" ");
    expect(replicated).toMatch(/LUA records/);
    expect(replicated).toMatch(/ALIAS records/);
    expect(signedZoneWarnings({ ...zone, kind: "Native" }, false)).toEqual([]);
  });
});

describe("bumpSoaSerial", () => {
  it("adds one to the serial", () => {
    expect(bumpSoaSerial("ns1.example.com. h.example.com. 2026100407 10800 3600 604800 3600")).toBe(
      "ns1.example.com. h.example.com. 2026100408 10800 3600 604800 3600",
    );
  });

  it("wraps per RFC 1982 and skips 0", () => {
    expect(bumpSoaSerial("a. b. 4294967295 1 1 1 1")).toBe("a. b. 1 1 1 1 1");
  });

  it("null on malformed content", () => {
    expect(bumpSoaSerial("a. b. x 1 1 1 1")).toBeNull();
    expect(bumpSoaSerial("a. b. 1")).toBeNull();
  });
});

describe("dsRecordsToPublish", () => {
  it("collects DS from active, published KSK/CSK only", () => {
    const ds = dsRecordsToPublish([
      { keytype: "csk", active: true, published: true, ds: ["1 13 2 AA", "1 13 4 BB"] },
      { keytype: "ksk", active: false, ds: ["2 13 2 CC"] },
      { keytype: "ksk", active: true, published: false, ds: ["3 13 2 DD"] },
      { keytype: "zsk", active: true, ds: ["4 13 2 EE"] },
    ]);
    expect(ds).toEqual(["1 13 2 AA", "1 13 4 BB"]);
  });
});

describe("helpers", () => {
  it("isTransferredKind", () => {
    expect(isTransferredKind("Master")).toBe(true);
    expect(isTransferredKind("primary")).toBe(true);
    expect(isTransferredKind("Native")).toBe(false);
    expect(isTransferredKind("Slave")).toBe(false);
  });

  it("sameZoneName ignores case and the trailing dot", () => {
    expect(sameZoneName("Example.COM", "example.com.")).toBe(true);
    expect(sameZoneName("example.org.", "example.com.")).toBe(false);
  });
});
