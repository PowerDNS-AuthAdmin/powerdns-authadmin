import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import { assertEditableZoneKind, isReadOnlyZoneKind, zoneCapabilities } from "./writable-kind";

describe("isReadOnlyZoneKind", () => {
  it("treats AXFR-mirror kinds (any case) as read-only, authoritative kinds as editable", () => {
    for (const k of ["slave", "Secondary", "CONSUMER"]) expect(isReadOnlyZoneKind(k)).toBe(true);
    for (const k of ["native", "Master", "Primary", "Producer"])
      expect(isReadOnlyZoneKind(k)).toBe(false);
  });
});

describe("assertEditableZoneKind", () => {
  it("throws ConflictError on mirror kinds, passes on authoritative", () => {
    expect(() => assertEditableZoneKind("Slave")).toThrow(ConflictError);
    expect(() => assertEditableZoneKind("Native")).not.toThrow();
  });
});

describe("zoneCapabilities", () => {
  it("authoritative kinds: content + DNSSEC editable, no upstream to mirror from", () => {
    for (const k of ["Native", "Master", "Producer"]) {
      const ops = zoneCapabilities(k);
      expect(ops).toEqual({
        rrsets: true,
        dnssec: true,
        metadata: true,
        masters: false,
        axfrRetrieve: false,
        delete: true,
      });
    }
  });

  it("mirror kinds: content + DNSSEC read-only, but masters/metadata/retrieve/delete open", () => {
    for (const k of ["Slave", "Secondary", "Consumer"]) {
      const ops = zoneCapabilities(k);
      expect(ops).toEqual({
        rrsets: false,
        dnssec: false,
        metadata: true,
        masters: true,
        axfrRetrieve: true,
        delete: true,
      });
    }
  });
});
