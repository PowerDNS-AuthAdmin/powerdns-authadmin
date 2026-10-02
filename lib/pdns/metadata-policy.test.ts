import { describe, expect, it } from "vitest";
import { ZONE_DEFAULT_TTL_KIND } from "@/lib/dns/default-ttl";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { PdnsMetadata } from "./types";
import {
  ENABLE_LUA_RECORDS_KIND,
  assertApiWritableMetadataKind,
  isApiWritableMetadataKind,
  isLuaEnabledByZoneMetadata,
  isLuaEnabledGlobally,
  normalizeMetadataValues,
} from "./metadata-policy";

const meta = (kind: string, values: string[]): PdnsMetadata => ({
  type: "Metadata",
  kind,
  metadata: values,
});

describe("isApiWritableMetadataKind", () => {
  // These exact kinds were verified to 422 on PUT against pdns-auth 4.9.16.
  it("refuses the protected DNSSEC / AXFR-TSIG kinds and ENABLE-LUA-RECORDS", () => {
    for (const k of [
      "NSEC3PARAM",
      "NSEC3NARROW",
      "PRESIGNED",
      "LUA-AXFR-SCRIPT",
      "AXFR-MASTER-TSIG",
      "TSIG-ALLOW-AXFR",
      ENABLE_LUA_RECORDS_KIND,
    ]) {
      expect(isApiWritableMetadataKind(k)).toBe(false);
    }
  });

  it("allows ordinary kinds and any X- custom kind", () => {
    for (const k of ["ALLOW-AXFR-FROM", "ALSO-NOTIFY", "SOA-EDIT-DNSUPDATE", "X-ANYTHING"]) {
      expect(isApiWritableMetadataKind(k)).toBe(true);
    }
  });
});

describe("assertApiWritableMetadataKind", () => {
  it("throws ForbiddenError for read-only kinds, passes writable ones", () => {
    expect(() => assertApiWritableMetadataKind(ENABLE_LUA_RECORDS_KIND)).toThrow(ForbiddenError);
    expect(() => assertApiWritableMetadataKind("NSEC3PARAM")).toThrow(ForbiddenError);
    expect(() => assertApiWritableMetadataKind("ALLOW-AXFR-FROM")).not.toThrow();
  });
});

describe("isLuaEnabledByZoneMetadata", () => {
  it("is true only when ENABLE-LUA-RECORDS carries a truthy value", () => {
    expect(isLuaEnabledByZoneMetadata([meta(ENABLE_LUA_RECORDS_KIND, ["1"])])).toBe(true);
    expect(isLuaEnabledByZoneMetadata([meta(ENABLE_LUA_RECORDS_KIND, ["yes"])])).toBe(true);
    expect(isLuaEnabledByZoneMetadata([meta(ENABLE_LUA_RECORDS_KIND, [" TRUE "])])).toBe(true);
  });

  it("is false when the flag is absent, empty, or falsey", () => {
    expect(isLuaEnabledByZoneMetadata([])).toBe(false);
    expect(isLuaEnabledByZoneMetadata([meta("ALSO-NOTIFY", ["192.0.2.1"])])).toBe(false);
    expect(isLuaEnabledByZoneMetadata([meta(ENABLE_LUA_RECORDS_KIND, [])])).toBe(false);
    expect(isLuaEnabledByZoneMetadata([meta(ENABLE_LUA_RECORDS_KIND, ["0"])])).toBe(false);
  });
});

describe("isLuaEnabledGlobally", () => {
  // 4.9 docs: enable-lua-records is one of `no` (default), `yes` (or empty), `shared`.
  it("is true for yes / shared / shard / empty", () => {
    for (const v of ["yes", "YES", "shared", "shard", "", "  "]) {
      expect(isLuaEnabledGlobally(v)).toBe(true);
    }
  });

  it("is false for no / absent / unrelated values", () => {
    for (const v of ["no", "NO", undefined, null, "maybe"]) {
      expect(isLuaEnabledGlobally(v)).toBe(false);
    }
  });
});

describe("normalizeMetadataValues", () => {
  it("canonicalises a valid per-zone default TTL", () => {
    expect(normalizeMetadataValues(ZONE_DEFAULT_TTL_KIND, [" 0300 "])).toEqual(["300"]);
  });

  it("rejects an invalid per-zone default TTL instead of storing it", () => {
    expect(() => normalizeMetadataValues(ZONE_DEFAULT_TTL_KIND, ["5m"])).toThrow(ValidationError);
    expect(() => normalizeMetadataValues(ZONE_DEFAULT_TTL_KIND, [])).toThrow(ValidationError);
  });

  it("passes other kinds through untouched", () => {
    expect(normalizeMetadataValues("X-SOMETHING", ["anything", "goes"])).toEqual([
      "anything",
      "goes",
    ]);
  });
});
