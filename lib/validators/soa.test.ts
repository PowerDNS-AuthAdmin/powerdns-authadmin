/**
 * lib/validators/soa.test.ts
 *
 * Roundtrip + sanity tests for the SOA parser/serializer.
 */

import { describe, expect, it } from "vitest";
import { parseSoaContent, serializeSoaContent, soaSanityWarnings, type SoaFields } from "./soa";

const SAMPLE: SoaFields = {
  mname: "ns1.example.com.",
  rname: "hostmaster.example.com.",
  serial: 2026051701,
  refresh: 3600,
  retry: 900,
  expire: 604800,
  minimum: 3600,
};

describe("SOA parse / serialize", () => {
  it("roundtrips an SOA RDATA string", () => {
    const text = serializeSoaContent(SAMPLE);
    expect(text).toBe("ns1.example.com. hostmaster.example.com. 2026051701 3600 900 604800 3600");
    expect(parseSoaContent(text)).toEqual(SAMPLE);
  });

  it("rejects malformed content", () => {
    expect(() => parseSoaContent("too few fields")).toThrow();
    expect(() => parseSoaContent("ns. host. serial refresh retry expire min")).toThrow();
  });
});

describe("SOA sanity warnings", () => {
  it("flags retry >= refresh", () => {
    const warnings = soaSanityWarnings({ ...SAMPLE, refresh: 60, retry: 90 });
    expect(warnings.some((w) => w.includes("Retry"))).toBe(true);
  });

  it("flags expire <= refresh + retry", () => {
    const warnings = soaSanityWarnings({
      ...SAMPLE,
      refresh: 3600,
      retry: 1800,
      expire: 5000,
    });
    expect(warnings.some((w) => w.includes("Expire"))).toBe(true);
  });

  it("flags refresh < 1200", () => {
    expect(soaSanityWarnings({ ...SAMPLE, refresh: 60 }).some((w) => w.includes("Refresh"))).toBe(
      true,
    );
  });

  it("returns empty for sane values", () => {
    expect(soaSanityWarnings(SAMPLE)).toEqual([]);
  });
});
