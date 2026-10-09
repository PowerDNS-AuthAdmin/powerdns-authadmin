/**
 * lib/validators/rrsets.test.ts
 *
 * The record-editor boundary. The `type` field of a change reaches the PDNS
 * PATCH body and the protected-RRset permission classifier verbatim, so both
 * change kinds must constrain it identically; the delete variant used to
 * accept any non-empty string.
 */

import { describe, expect, it } from "vitest";
import { patchRRsetsSchema, rrsetChangeSchema } from "./rrsets";

const upsert = (type: string) => ({
  kind: "upsert" as const,
  name: "www",
  type,
  ttl: 300,
  records: [{ content: "192.0.2.1" }],
});

const del = (type: string) => ({ kind: "delete" as const, name: "www", type });

describe("rrsetChangeSchema type field", () => {
  it("uppercases and accepts RR mnemonics on both change kinds", () => {
    expect(rrsetChangeSchema.parse(upsert("a")).type).toBe("A");
    expect(rrsetChangeSchema.parse(del("txt")).type).toBe("TXT");
    expect(rrsetChangeSchema.parse(del("TYPE65534")).type).toBe("TYPE65534");
  });

  it("rejects a type that is not 1-12 alphanumerics on a delete as well as an upsert", () => {
    for (const bad of ["A; DROP", "a b", "ns.", "\u0000A", "x".repeat(13), "соа"]) {
      expect(rrsetChangeSchema.safeParse(upsert(bad)).success).toBe(false);
      expect(rrsetChangeSchema.safeParse(del(bad)).success).toBe(false);
    }
  });

  it("rejects an empty type", () => {
    expect(rrsetChangeSchema.safeParse(del("")).success).toBe(false);
  });
});

describe("patchRRsetsSchema", () => {
  it("needs a server slug and at least one change", () => {
    expect(patchRRsetsSchema.safeParse({ serverSlug: "s", changes: [] }).success).toBe(false);
    expect(patchRRsetsSchema.safeParse({ serverSlug: "", changes: [del("A")] }).success).toBe(
      false,
    );
    expect(patchRRsetsSchema.safeParse({ serverSlug: "s", changes: [del("A")] }).success).toBe(
      true,
    );
  });
});
