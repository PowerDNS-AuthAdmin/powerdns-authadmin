/**
 * lib/pdns/rrsets.test.ts - patch-builder semantics.
 *
 * The builders are tiny but the trailing-dot + uppercase-type invariants are
 * load-bearing on the PDNS wire format - covering them here keeps a
 *refactor from regressing the contract.
 */

import { describe, expect, it } from "vitest";
import { deleteRRset, extendRRset, pruneRRset, replaceRRset, zonePatchBody } from "./rrsets";

describe("replaceRRset", () => {
  it("normalizes name + type and carries records", () => {
    const patch = replaceRRset({
      name: "www.example.com",
      type: "a",
      ttl: 300,
      records: [{ content: "1.2.3.4" }],
    });
    expect(patch).toEqual({
      name: "www.example.com.",
      type: "A",
      ttl: 300,
      changetype: "REPLACE",
      records: [{ content: "1.2.3.4" }],
      comments: [],
    });
  });

  it("refuses an empty record list", () => {
    expect(() => replaceRRset({ name: "x.y.", type: "TXT", ttl: 60, records: [] })).toThrow(
      /at least one record/,
    );
  });
});

describe("deleteRRset", () => {
  it("omits ttl and records", () => {
    expect(deleteRRset("www.example.com.", "a")).toEqual({
      name: "www.example.com.",
      type: "A",
      changetype: "DELETE",
    });
  });
});

describe("extendRRset + pruneRRset", () => {
  it("extend rejects empty records", () => {
    expect(() => extendRRset({ name: "x.y.", type: "A", ttl: 60, records: [] })).toThrow();
  });
  it("prune rejects empty records", () => {
    expect(() => pruneRRset({ name: "x.y.", type: "A", ttl: 60, records: [] })).toThrow();
  });
});

describe("zonePatchBody", () => {
  it("packs patches under `rrsets`", () => {
    const body = zonePatchBody(
      replaceRRset({
        name: "a.example.com.",
        type: "A",
        ttl: 60,
        records: [{ content: "1.1.1.1" }],
      }),
      deleteRRset("b.example.com.", "TXT"),
    );
    expect(body.rrsets).toHaveLength(2);
    expect(body.rrsets[1]?.changetype).toBe("DELETE");
  });

  it("refuses an empty patch list", () => {
    expect(() => zonePatchBody()).toThrow(/at least one/);
  });
});
