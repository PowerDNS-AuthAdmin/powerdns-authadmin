import { describe, expect, it } from "vitest";
import { canonicalZoneName, displayZoneName, sameZoneName } from "./zone-name";

describe("canonicalZoneName", () => {
  it("lowercases, trims and appends exactly one trailing dot", () => {
    expect(canonicalZoneName("Example.COM")).toBe("example.com.");
    expect(canonicalZoneName("  example.com.  ")).toBe("example.com.");
    expect(canonicalZoneName("example.com.")).toBe("example.com.");
  });

  it("keeps the empty string empty rather than producing the root zone", () => {
    expect(canonicalZoneName("")).toBe("");
    expect(canonicalZoneName("   ")).toBe("");
  });

  it("is idempotent", () => {
    for (const s of ["Example.COM", "a.b.c.", " x ", "."]) {
      expect(canonicalZoneName(canonicalZoneName(s))).toBe(canonicalZoneName(s));
    }
  });
});

describe("sameZoneName", () => {
  it("ignores case and the trailing dot", () => {
    expect(sameZoneName("Example.COM", "example.com.")).toBe(true);
    expect(sameZoneName("example.org.", "example.com.")).toBe(false);
  });
});

describe("displayZoneName", () => {
  it("strips only the trailing dot", () => {
    expect(displayZoneName("example.com.")).toBe("example.com");
    expect(displayZoneName("example.com")).toBe("example.com");
  });
});
