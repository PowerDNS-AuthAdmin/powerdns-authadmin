/**
 * lib/pdns/cryptokeys.test.ts
 *
 * Schema-level coverage for the DNSSEC cryptokey responses the client
 * parses. Mirrors the patterns the `PdnsClient.{list,get}Cryptokeys`
 * methods consume - fixtures lifted from PDNS Authoritative docs +
 * representative real-world bodies.
 *
 * The transport itself reuses the same `pdnsRequest` plumbing as
 * `listZones` / `getZone`, which is covered by the integration suite
 * (`tests/integration/`). Here we ensure the schemas don't
 * over-reject genuine PDNS bodies AND don't silently accept
 * impossible ones.
 */

import { describe, expect, it } from "vitest";
import {
  pdnsCryptokeyDetailSchema,
  pdnsCryptokeyListSchema,
  pdnsCryptokeySummarySchema,
} from "./types";

const PDNS_45_KSK = {
  type: "Cryptokey",
  id: 1,
  keytype: "ksk",
  active: true,
  published: true,
  dnskey: "257 3 13 AbCdEf...",
  ds: ["12345 13 1 abc...", "12345 13 2 def...", "12345 13 4 ghi..."],
  cds: ["12345 13 2 def..."],
  algorithm: "ECDSAP256SHA256",
  bits: 256,
};

const PDNS_45_ZSK = {
  type: "Cryptokey",
  id: 2,
  keytype: "zsk",
  active: true,
  published: true,
  dnskey: "256 3 13 XyZ...",
  ds: [],
  algorithm: "ECDSAP256SHA256",
  bits: 256,
};

// Older PDNS (4.0-ish) - no `published`, no `cds`, no `algorithm`/`bits`.
const PDNS_40_LEGACY = {
  id: 99,
  keytype: "ksk",
  active: true,
  dnskey: "257 3 8 R...",
  ds: ["99 8 1 ...", "99 8 2 ..."],
};

describe("pdnsCryptokeySummarySchema", () => {
  it("accepts a modern KSK body with all optional fields", () => {
    const parsed = pdnsCryptokeySummarySchema.parse(PDNS_45_KSK);
    expect(parsed.keytype).toBe("ksk");
    expect(parsed.ds).toHaveLength(3);
    expect(parsed.bits).toBe(256);
  });

  it("accepts a ZSK body where `ds` is empty", () => {
    const parsed = pdnsCryptokeySummarySchema.parse(PDNS_45_ZSK);
    expect(parsed.keytype).toBe("zsk");
    expect(parsed.ds).toEqual([]);
  });

  it("accepts a legacy body missing optional fields", () => {
    const parsed = pdnsCryptokeySummarySchema.parse(PDNS_40_LEGACY);
    expect(parsed.keytype).toBe("ksk");
    expect(parsed.published).toBeUndefined();
    expect(parsed.algorithm).toBeUndefined();
    expect(parsed.bits).toBeUndefined();
    expect(parsed.cds).toBeUndefined();
  });

  it("passes through unknown keytype strings (forward-compatible)", () => {
    const parsed = pdnsCryptokeySummarySchema.parse({
      ...PDNS_45_KSK,
      keytype: "future-key-type-pdns-7",
    });
    expect(parsed.keytype).toBe("future-key-type-pdns-7");
  });

  it("rejects when required `dnskey` is missing", () => {
    const { dnskey: _unused, ...rest } = PDNS_45_KSK;
    expect(() => pdnsCryptokeySummarySchema.parse(rest)).toThrow();
  });

  it("rejects when `active` is missing", () => {
    const { active: _unused, ...rest } = PDNS_45_KSK;
    expect(() => pdnsCryptokeySummarySchema.parse(rest)).toThrow();
  });

  it("rejects negative ids (PDNS auto-increments from 1)", () => {
    expect(() => pdnsCryptokeySummarySchema.parse({ ...PDNS_45_KSK, id: -1 })).toThrow();
  });
});

describe("pdnsCryptokeyListSchema", () => {
  it("accepts an empty array (zone without DNSSEC)", () => {
    expect(pdnsCryptokeyListSchema.parse([])).toEqual([]);
  });

  it("parses a mixed KSK/ZSK list and preserves order", () => {
    const parsed = pdnsCryptokeyListSchema.parse([PDNS_45_KSK, PDNS_45_ZSK]);
    expect(parsed.map((k) => k.keytype)).toEqual(["ksk", "zsk"]);
    expect(parsed.map((k) => k.id)).toEqual([1, 2]);
  });

  it("rejects a list where any element is missing required fields", () => {
    expect(() => pdnsCryptokeyListSchema.parse([PDNS_45_KSK, { id: 3 }])).toThrow();
  });
});

describe("pdnsCryptokeyDetailSchema", () => {
  it("is identical in shape to the summary schema (no extra fields)", () => {
    // If this ever diverges intentionally we want a test failure that
    // forces a deliberate look - the comment in types.ts says we
    // skip `privatekey` on purpose.
    expect(pdnsCryptokeyDetailSchema.parse(PDNS_45_KSK)).toEqual(
      pdnsCryptokeySummarySchema.parse(PDNS_45_KSK),
    );
  });
});

describe("PdnsClient.updateCryptokey guard", () => {
  // The constructor needs a real PdnsClientConfig but updateCryptokey's
  // empty-patch guard fires before any HTTP. Stand up a client with a
  // never-callable apiKey/baseUrl so the test fails loudly if the guard
  // ever stops firing first.
  it("throws when neither active nor published is supplied", async () => {
    const { PdnsClient } = await import("./client");
    const client = new PdnsClient({
      baseUrl: "http://unused.invalid",
      apiKey: "unused",
      serverSlug: "unused",
      serverId: "localhost",
    });
    await expect(client.updateCryptokey("example.com.", 1, {})).rejects.toThrow(
      /at least one of active\/published/,
    );
  });
});
