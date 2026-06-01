import { describe, expect, it } from "vitest";
import { parsePageSizeParam, parseSortParam, serializeSortParam } from "./data-table-url-sync";

describe("parseSortParam", () => {
  it("returns empty array for null / empty input", () => {
    expect(parseSortParam(null)).toEqual([]);
    expect(parseSortParam("")).toEqual([]);
  });

  it("parses a single asc entry", () => {
    expect(parseSortParam("name.asc")).toEqual([{ id: "name", desc: false }]);
  });

  it("parses a single desc entry", () => {
    expect(parseSortParam("createdAt.desc")).toEqual([{ id: "createdAt", desc: true }]);
  });

  it("parses multi-column comma-separated", () => {
    expect(parseSortParam("name.asc,createdAt.desc")).toEqual([
      { id: "name", desc: false },
      { id: "createdAt", desc: true },
    ]);
  });

  it("drops entries with unknown direction (graceful for renamed columns or stale links)", () => {
    expect(parseSortParam("name.asc,bogus.xyz,createdAt.desc")).toEqual([
      { id: "name", desc: false },
      { id: "createdAt", desc: true },
    ]);
  });

  it("drops entries with missing id", () => {
    expect(parseSortParam(".asc,name.asc")).toEqual([{ id: "name", desc: false }]);
  });

  it("drops entries with no direction marker at all", () => {
    expect(parseSortParam("name")).toEqual([]);
  });
});

describe("serializeSortParam", () => {
  it("returns empty string for empty sort state", () => {
    expect(serializeSortParam([])).toBe("");
  });

  it("serializes single entry", () => {
    expect(serializeSortParam([{ id: "name", desc: false }])).toBe("name.asc");
    expect(serializeSortParam([{ id: "name", desc: true }])).toBe("name.desc");
  });

  it("joins multi-column with comma", () => {
    expect(
      serializeSortParam([
        { id: "name", desc: false },
        { id: "createdAt", desc: true },
      ]),
    ).toBe("name.asc,createdAt.desc");
  });

  it("is the inverse of parseSortParam (round-trip)", () => {
    const cases = ["name.asc", "name.desc", "name.asc,createdAt.desc", "lastAdminEditIso.desc"];
    for (const c of cases) {
      expect(serializeSortParam(parseSortParam(c))).toBe(c);
    }
  });
});

describe("parsePageSizeParam", () => {
  const allowed = [10, 25, 50, 100] as const;

  it("returns null for null / empty input", () => {
    expect(parsePageSizeParam(null, allowed)).toBeNull();
    expect(parsePageSizeParam("", allowed)).toBeNull();
  });

  it("returns the integer when it's in the allowed set", () => {
    expect(parsePageSizeParam("25", allowed)).toBe(25);
    expect(parsePageSizeParam("100", allowed)).toBe(100);
  });

  it("returns null for an integer outside the allowed set (prevents DOM blow-up)", () => {
    // `?pageSize=9999` could come from a forged link - must NOT
    // grant a 9999-row render.
    expect(parsePageSizeParam("9999", allowed)).toBeNull();
    expect(parsePageSizeParam("1", allowed)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parsePageSizeParam("abc", allowed)).toBeNull();
  });

  it("returns null for zero or negative numbers", () => {
    expect(parsePageSizeParam("0", allowed)).toBeNull();
    expect(parsePageSizeParam("-25", allowed)).toBeNull();
  });

  it("parseInt-tolerates trailing junk (matches Number.parseInt semantics)", () => {
    // This is a deliberate documentation test: parseInt("25xyz", 10)
    // returns 25, so the helper accepts it if 25 is allowed. If
    // tighter validation is ever desired the implementation needs
    // to change AND this test needs updating.
    expect(parsePageSizeParam("25xyz", allowed)).toBe(25);
  });
});
