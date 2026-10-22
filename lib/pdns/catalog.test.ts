import { describe, expect, it } from "vitest";
import {
  catalogHealthInputs,
  catalogMemberCounts,
  catalogMembers,
  producerZoneNames,
  type CatalogZoneLike,
} from "./catalog";

const zone = (name: string, kind: string, catalog: string | null = null): CatalogZoneLike => ({
  name,
  kind,
  catalog,
});

const fleet = [
  zone("catalog.invalid.", "Producer"),
  zone("a.example.", "Master", "catalog.invalid."),
  zone("b.example.", "Master", "Catalog.Invalid"),
  zone("c.example.", "Native"),
  zone("d.example.", "Master", "gone.invalid."),
];

describe("catalog membership", () => {
  it("counts members per catalog, whatever the spelling", () => {
    expect(catalogMemberCounts(fleet)).toEqual(
      new Map([
        ["catalog.invalid.", 2],
        ["gone.invalid.", 1],
      ]),
    );
  });

  it("lists a catalog's members and the backend's producers", () => {
    expect(catalogMembers(fleet, "catalog.invalid")).toEqual(["a.example.", "b.example."]);
    expect(producerZoneNames(fleet)).toEqual(["catalog.invalid."]);
  });
});

describe("catalogHealthInputs", () => {
  it("reports a catalog its members name but nobody serves", () => {
    expect(catalogHealthInputs(fleet, undefined)).toEqual({
      orphanedCatalogs: [{ catalog: "gone.invalid.", members: 1 }],
      defaultCatalogProblem: null,
    });
  });

  it("accepts a Consumer zone as the catalog on a secondary", () => {
    const secondary = [
      zone("catalog.invalid.", "Consumer"),
      zone("a.example.", "Slave", "catalog.invalid."),
    ];
    expect(catalogHealthInputs(secondary, undefined).orphanedCatalogs).toEqual([]);
  });

  it("flags a default-catalog-zone that is missing or not a Producer", () => {
    expect(catalogHealthInputs(fleet, "catalog.invalid.").defaultCatalogProblem).toBeNull();
    expect(catalogHealthInputs(fleet, "nope.invalid.").defaultCatalogProblem).toEqual({
      name: "nope.invalid.",
      problem: "missing",
    });
    expect(catalogHealthInputs(fleet, "c.example").defaultCatalogProblem).toEqual({
      name: "c.example.",
      problem: "not-producer",
    });
  });
});
