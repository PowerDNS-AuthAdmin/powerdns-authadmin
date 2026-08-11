import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZONE_HORIZON,
  ZONE_HORIZONS,
  isZoneHorizon,
  toZoneHorizon,
  zoneHorizonLabel,
} from "./zone-horizon";

describe("zone horizon vocabulary", () => {
  it("defaults to public - an unclassified zone must not be reclassified", () => {
    expect(DEFAULT_ZONE_HORIZON).toBe("public");
  });

  it("accepts only the known horizons", () => {
    expect(ZONE_HORIZONS).toEqual(["public", "internal"]);
    expect(isZoneHorizon("public")).toBe(true);
    expect(isZoneHorizon("internal")).toBe(true);
    expect(isZoneHorizon("INTERNAL")).toBe(false);
    expect(isZoneHorizon("dmz")).toBe(false);
    expect(isZoneHorizon(undefined)).toBe(false);
    expect(isZoneHorizon(null)).toBe(false);
    expect(isZoneHorizon(1)).toBe(false);
  });

  it("coerces anything unrecognized to the default rather than throwing", () => {
    expect(toZoneHorizon("internal")).toBe("internal");
    expect(toZoneHorizon("public")).toBe("public");
    expect(toZoneHorizon("nonsense")).toBe("public");
    expect(toZoneHorizon(null)).toBe("public");
  });

  it("labels both horizons", () => {
    expect(zoneHorizonLabel("internal")).toBe("internal");
    expect(zoneHorizonLabel("public")).toBe("public");
  });
});
