import { describe, expect, it } from "vitest";
import { pdnsTsigKeyDetailSchema, pdnsTsigKeyListSchema, pdnsTsigKeySummarySchema } from "./types";

const SUMMARY = {
  type: "TSIGKey",
  id: "primary.",
  name: "primary",
  algorithm: "hmac-sha256",
};

const DETAIL = {
  ...SUMMARY,
  key: "AbCdEf0123456789AbCdEf0123456789AbCdEf01==",
};

describe("pdnsTsigKeySummarySchema", () => {
  it("accepts a list element from a modern PDNS", () => {
    const parsed = pdnsTsigKeySummarySchema.parse(SUMMARY);
    expect(parsed.name).toBe("primary");
    expect(parsed.algorithm).toBe("hmac-sha256");
  });

  it("accepts a body without the `type` discriminator (older PDNS)", () => {
    const { type: _unused, ...rest } = SUMMARY;
    const parsed = pdnsTsigKeySummarySchema.parse(rest);
    expect(parsed.type).toBeUndefined();
  });

  it("passes through an unknown algorithm string for forward-compat", () => {
    const parsed = pdnsTsigKeySummarySchema.parse({
      ...SUMMARY,
      algorithm: "future-algorithm-pdns-7",
    });
    expect(parsed.algorithm).toBe("future-algorithm-pdns-7");
  });

  it("rejects when required `name` is missing", () => {
    const { name: _unused, ...rest } = SUMMARY;
    expect(() => pdnsTsigKeySummarySchema.parse(rest)).toThrow();
  });

  it("rejects when `id` is missing", () => {
    const { id: _unused, ...rest } = SUMMARY;
    expect(() => pdnsTsigKeySummarySchema.parse(rest)).toThrow();
  });

  it("silently drops a `key` field on the summary shape", () => {
    // If a future PDNS started returning the secret on the list
    // endpoint, the summary type shouldn't expose it — the detail
    // endpoint is the only sanctioned path. Zod's default behavior
    // is to drop unknown fields on `.parse()`, which is what we want.
    const parsed = pdnsTsigKeySummarySchema.parse(DETAIL);
    expect(parsed).not.toHaveProperty("key");
  });
});

describe("pdnsTsigKeyListSchema", () => {
  it("accepts an empty list", () => {
    expect(pdnsTsigKeyListSchema.parse([])).toEqual([]);
  });

  it("parses a multi-key list and preserves order", () => {
    const a = { ...SUMMARY, id: "a.", name: "a" };
    const b = { ...SUMMARY, id: "b.", name: "b" };
    const c = { ...SUMMARY, id: "c.", name: "c" };
    const parsed = pdnsTsigKeyListSchema.parse([a, b, c]);
    expect(parsed.map((k) => k.name)).toEqual(["a", "b", "c"]);
  });
});

describe("pdnsTsigKeyDetailSchema", () => {
  it("includes `key` on the detail shape", () => {
    const parsed = pdnsTsigKeyDetailSchema.parse(DETAIL);
    expect(parsed.key).toBe(DETAIL.key);
  });

  it("rejects when `key` is missing", () => {
    const { key: _unused, ...rest } = DETAIL;
    expect(() => pdnsTsigKeyDetailSchema.parse(rest)).toThrow();
  });
});
