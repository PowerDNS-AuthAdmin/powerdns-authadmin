import { describe, expect, it } from "vitest";
import {
  BUILTIN_DEFAULT_TTL,
  MAX_DEFAULT_TTL,
  parseDefaultTtl,
  resolveDefaultTtl,
  ZONE_DEFAULT_TTL_KIND,
  zoneDefaultTtlFromMetadata,
  zoneDefaultTtlValuesError,
} from "./default-ttl";

describe("parseDefaultTtl", () => {
  it("accepts whole numbers in range, tolerating surrounding whitespace", () => {
    expect(parseDefaultTtl("300")).toBe(300);
    expect(parseDefaultTtl(" 60 ")).toBe(60);
    expect(parseDefaultTtl("1")).toBe(1);
    expect(parseDefaultTtl(String(MAX_DEFAULT_TTL))).toBe(MAX_DEFAULT_TTL);
  });

  it("rejects zero, out-of-range, signed, fractional and non-numeric values", () => {
    for (const bad of ["0", String(MAX_DEFAULT_TTL + 1), "-5", "+5", "1.5", "5m", "", "1e3"]) {
      expect(parseDefaultTtl(bad), bad).toBeNull();
    }
  });
});

describe("zoneDefaultTtlFromMetadata", () => {
  it("reads the first value of the per-zone kind", () => {
    expect(
      zoneDefaultTtlFromMetadata([
        { kind: "ALLOW-AXFR-FROM", metadata: ["10.0.0.0/8"] },
        { kind: ZONE_DEFAULT_TTL_KIND, metadata: ["120"] },
      ]),
    ).toBe(120);
  });

  it("is null when the kind is absent, empty, or holds garbage", () => {
    expect(zoneDefaultTtlFromMetadata([])).toBeNull();
    expect(zoneDefaultTtlFromMetadata([{ kind: ZONE_DEFAULT_TTL_KIND, metadata: [] }])).toBeNull();
    expect(
      zoneDefaultTtlFromMetadata([{ kind: ZONE_DEFAULT_TTL_KIND, metadata: ["soon"] }]),
    ).toBeNull();
  });
});

describe("resolveDefaultTtl", () => {
  it("prefers the zone value, then the global setting, then the built-in", () => {
    expect(resolveDefaultTtl({ zone: 60, global: 300 })).toEqual({ ttl: 60, source: "zone" });
    expect(resolveDefaultTtl({ zone: null, global: 300 })).toEqual({ ttl: 300, source: "global" });
    expect(resolveDefaultTtl({ zone: null, global: null })).toEqual({
      ttl: BUILTIN_DEFAULT_TTL,
      source: "builtin",
    });
  });
});

describe("zoneDefaultTtlValuesError", () => {
  it("passes exactly one valid value", () => {
    expect(zoneDefaultTtlValuesError(["300"])).toBeNull();
  });

  it("rejects no value, several values, or an invalid one", () => {
    expect(zoneDefaultTtlValuesError([])).toMatch(ZONE_DEFAULT_TTL_KIND);
    expect(zoneDefaultTtlValuesError(["300", "600"])).not.toBeNull();
    expect(zoneDefaultTtlValuesError(["0"])).not.toBeNull();
  });
});
