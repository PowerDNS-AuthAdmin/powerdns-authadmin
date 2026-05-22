/**
 * lib/pdns/metadata.test.ts
 *
 * Schema-level coverage for zone metadata responses.
 */

import { describe, expect, it } from "vitest";
import { pdnsMetadataListSchema, pdnsMetadataSchema } from "./types";

const ALSO_NOTIFY = {
  type: "Metadata",
  kind: "ALSO-NOTIFY",
  metadata: ["192.0.2.10", "[2001:db8::10]:5353"],
};

const ALLOW_AXFR_FROM_SINGLE = {
  type: "Metadata",
  kind: "ALLOW-AXFR-FROM",
  metadata: ["192.0.2.0/24"],
};

// PDNS sometimes returns metadata without the `type` discriminator
// (older or non-standard surfaces); the schema treats it as optional.
const LEGACY_NO_TYPE = {
  kind: "API-RECTIFY",
  metadata: ["1"],
};

const EMPTY_METADATA = {
  type: "Metadata",
  kind: "PUBLISH-CDS",
  metadata: [],
};

const FUTURE_KIND = {
  type: "Metadata",
  kind: "FUTURE-PDNS-7-KIND",
  metadata: ["whatever"],
};

describe("pdnsMetadataSchema", () => {
  it("accepts ALSO-NOTIFY with multiple values", () => {
    const parsed = pdnsMetadataSchema.parse(ALSO_NOTIFY);
    expect(parsed.kind).toBe("ALSO-NOTIFY");
    expect(parsed.metadata).toHaveLength(2);
  });

  it("accepts a single-value metadata entry", () => {
    const parsed = pdnsMetadataSchema.parse(ALLOW_AXFR_FROM_SINGLE);
    expect(parsed.metadata).toEqual(["192.0.2.0/24"]);
  });

  it("accepts a body missing the `type` discriminator", () => {
    const parsed = pdnsMetadataSchema.parse(LEGACY_NO_TYPE);
    expect(parsed.type).toBeUndefined();
    expect(parsed.kind).toBe("API-RECTIFY");
  });

  it("accepts an empty metadata array (kind exists but holds nothing)", () => {
    expect(() => pdnsMetadataSchema.parse(EMPTY_METADATA)).not.toThrow();
  });

  it("passes through unknown kinds without rejecting", () => {
    expect(pdnsMetadataSchema.parse(FUTURE_KIND).kind).toBe("FUTURE-PDNS-7-KIND");
  });

  it("rejects when `kind` is missing", () => {
    const { kind: _unused, ...rest } = ALSO_NOTIFY;
    expect(() => pdnsMetadataSchema.parse(rest)).toThrow();
  });

  it("rejects when `metadata` is not an array of strings", () => {
    expect(() => pdnsMetadataSchema.parse({ ...ALSO_NOTIFY, metadata: [1, 2, 3] })).toThrow();
    expect(() => pdnsMetadataSchema.parse({ ...ALSO_NOTIFY, metadata: "single-string" })).toThrow();
  });
});

describe("pdnsMetadataListSchema", () => {
  it("accepts an empty list (zone with no metadata configured)", () => {
    expect(pdnsMetadataListSchema.parse([])).toEqual([]);
  });

  it("parses a mixed list preserving order", () => {
    const parsed = pdnsMetadataListSchema.parse([
      ALSO_NOTIFY,
      ALLOW_AXFR_FROM_SINGLE,
      EMPTY_METADATA,
    ]);
    expect(parsed.map((m) => m.kind)).toEqual(["ALSO-NOTIFY", "ALLOW-AXFR-FROM", "PUBLISH-CDS"]);
  });

  it("rejects a list with any malformed element", () => {
    expect(() => pdnsMetadataListSchema.parse([ALSO_NOTIFY, { metadata: ["x"] }])).toThrow();
  });
});
