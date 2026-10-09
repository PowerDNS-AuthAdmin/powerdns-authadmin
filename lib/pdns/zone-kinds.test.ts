import { describe, expect, it } from "vitest";
import { isMirrorKind, isTransferredKind } from "./zone-kinds";

describe("zone kinds", () => {
  it("mirror kinds are the AXFR consumers, in either PDNS spelling", () => {
    for (const k of ["Slave", "slave", "Secondary", "SECONDARY", "Consumer"]) {
      expect(isMirrorKind(k)).toBe(true);
      expect(isTransferredKind(k)).toBe(false);
    }
  });

  it("transferred kinds include the catalog Producer alongside Master/Primary", () => {
    for (const k of ["Master", "master", "Primary", "PRIMARY", "Producer"]) {
      expect(isTransferredKind(k)).toBe(true);
      expect(isMirrorKind(k)).toBe(false);
    }
  });

  it("Native is neither mirrored nor transferred", () => {
    expect(isMirrorKind("Native")).toBe(false);
    expect(isTransferredKind("Native")).toBe(false);
  });

  it("the two sets are disjoint", () => {
    for (const k of ["Master", "Primary", "Producer", "Slave", "Secondary", "Consumer", "Native"]) {
      expect(isMirrorKind(k) && isTransferredKind(k)).toBe(false);
    }
  });
});
