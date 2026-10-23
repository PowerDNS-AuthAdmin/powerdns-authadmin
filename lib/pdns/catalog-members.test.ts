import { describe, expect, it } from "vitest";
import { buildVersionCache } from "./version";
import { liveCatalogMembers } from "./catalog-members";

interface FakeZone {
  name: string;
  kind: string;
  catalog?: string;
}

function fakeClient(version: string, zones: FakeZone[], unreadable: string[] = []) {
  return {
    listZones: () =>
      Promise.resolve(
        zones.map((z) => ({
          ...z,
          id: z.name,
          // 4.7 / 4.8 leave the field empty in the list; the single-zone GET has it.
          catalog: version.startsWith("4.7") || version.startsWith("4.8") ? "" : z.catalog,
        })),
      ),
    getZone: (name: string) => {
      if (unreadable.includes(name)) return Promise.reject(new Error("boom"));
      const z = zones.find((zz) => zz.name === name)!;
      return Promise.resolve({ ...z, id: z.name });
    },
    version: () =>
      Promise.resolve({ cache: buildVersionCache(version, "localhost"), refreshed: false }),
  } as unknown as Parameters<typeof liveCatalogMembers>[0];
}

const zones: FakeZone[] = [
  { name: "catalog.invalid.", kind: "Producer" },
  { name: "a.example.", kind: "Master", catalog: "catalog.invalid." },
  { name: "b.example.", kind: "Native", catalog: "Catalog.Invalid." },
  { name: "c.example.", kind: "Native" },
];

describe("liveCatalogMembers", () => {
  it("reads membership off the zone list on PowerDNS 4.9+", async () => {
    expect(await liveCatalogMembers(fakeClient("4.9.4", zones), "catalog.invalid.")).toEqual({
      members: ["a.example.", "b.example."],
      complete: true,
    });
  });

  it("reads each zone on PowerDNS 4.7 / 4.8, where the list leaves catalog empty", async () => {
    expect(await liveCatalogMembers(fakeClient("4.8.5", zones), "catalog.invalid.")).toEqual({
      members: ["a.example.", "b.example."],
      complete: true,
    });
  });

  it("marks the count incomplete when a zone can't be read", async () => {
    const result = await liveCatalogMembers(
      fakeClient("4.7.5", zones, ["b.example."]),
      "catalog.invalid.",
    );
    expect(result).toEqual({ members: ["a.example."], complete: false });
  });
});
