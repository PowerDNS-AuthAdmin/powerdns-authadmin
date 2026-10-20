import { describe, expect, it } from "vitest";
import {
  autoPtrFlagValue,
  parseAutoPtrFlag,
  resolveAutoPtr,
  ZONE_AUTO_PTR_KIND,
  zoneAutoPtrFromMetadata,
  zoneAutoPtrValuesError,
} from "./auto-ptr-setting";

describe("parseAutoPtrFlag", () => {
  it("accepts the usual boolean spellings", () => {
    for (const v of ["on", "ON", " yes ", "true", "1"]) expect(parseAutoPtrFlag(v)).toBe(true);
    for (const v of ["off", "No", "false", "0"]) expect(parseAutoPtrFlag(v)).toBe(false);
    for (const v of ["", "maybe", "2", "enabled"]) expect(parseAutoPtrFlag(v)).toBeNull();
  });
});

describe("zoneAutoPtrFromMetadata", () => {
  it("reads the first value of the kind and ignores garbage", () => {
    expect(zoneAutoPtrFromMetadata([{ kind: ZONE_AUTO_PTR_KIND, metadata: ["on"] }])).toBe(true);
    expect(zoneAutoPtrFromMetadata([{ kind: ZONE_AUTO_PTR_KIND, metadata: ["off"] }])).toBe(false);
    expect(zoneAutoPtrFromMetadata([{ kind: ZONE_AUTO_PTR_KIND, metadata: ["bogus"] }])).toBeNull();
    expect(
      zoneAutoPtrFromMetadata([{ kind: "SOA-EDIT", metadata: ["INCEPTION-INCREMENT"] }]),
    ).toBeNull();
    expect(zoneAutoPtrFromMetadata([])).toBeNull();
  });
});

describe("resolveAutoPtr", () => {
  it("prefers the change, then the zone, then the global setting, then off", () => {
    expect(resolveAutoPtr({ change: false, zone: true, global: true })).toEqual({
      enabled: false,
      source: "change",
    });
    expect(resolveAutoPtr({ change: undefined, zone: true, global: false })).toEqual({
      enabled: true,
      source: "zone",
    });
    expect(resolveAutoPtr({ zone: null, global: true })).toEqual({
      enabled: true,
      source: "global",
    });
    expect(resolveAutoPtr({ zone: null, global: null })).toEqual({
      enabled: false,
      source: "builtin",
    });
  });
});

describe("zoneAutoPtrValuesError / autoPtrFlagValue", () => {
  it("requires exactly one on/off value", () => {
    expect(zoneAutoPtrValuesError(["on"])).toBeNull();
    expect(zoneAutoPtrValuesError(["yes"])).toBeNull();
    expect(zoneAutoPtrValuesError([])).toMatch(/on or off/);
    expect(zoneAutoPtrValuesError(["on", "off"])).toMatch(/on or off/);
    expect(zoneAutoPtrValuesError(["sometimes"])).toMatch(/on or off/);
  });
  it("stores the canonical spelling", () => {
    expect(autoPtrFlagValue(true)).toBe("on");
    expect(autoPtrFlagValue(false)).toBe("off");
  });
});
