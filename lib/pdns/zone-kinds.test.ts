import { describe, expect, it } from "vitest";
import {
  catalogRole,
  isMirrorKind,
  isSystemKind,
  isTransferredKind,
  mirrorFollowsZone,
} from "./zone-kinds";

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

describe("system kinds", () => {
  it("are the catalog Producer and Consumer, case-insensitively", () => {
    for (const k of ["Producer", "producer", "Consumer", "CONSUMER"]) {
      expect(isSystemKind(k)).toBe(true);
    }
    for (const k of ["Master", "Primary", "Slave", "Secondary", "Native"]) {
      expect(isSystemKind(k)).toBe(false);
    }
  });

  it("name the catalog side", () => {
    expect(catalogRole("Producer")).toBe("producer");
    expect(catalogRole("consumer")).toBe("consumer");
    expect(catalogRole("Master")).toBeNull();
  });
});

describe("mirrorFollowsZone", () => {
  it("counts a catalog Producer only on a mirror that consumes it", () => {
    expect(mirrorFollowsZone("Producer", false)).toBe(false);
    expect(mirrorFollowsZone("producer", true)).toBe(true);
  });

  it("leaves every other kind to the caller", () => {
    for (const k of ["Master", "Primary", "Native"]) {
      expect(mirrorFollowsZone(k, false)).toBe(true);
      expect(mirrorFollowsZone(k, true)).toBe(true);
    }
  });
});
