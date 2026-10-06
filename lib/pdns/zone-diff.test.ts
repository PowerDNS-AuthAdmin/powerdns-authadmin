import { describe, expect, it } from "vitest";
import { diffZoneRecords, maskSoaSerial, type DiffRRset } from "./zone-diff";

const rr = (name: string, type: string, ...contents: string[]): DiffRRset => ({
  name,
  type,
  ttl: 3600,
  records: contents.map((content) => ({ content })),
});

const SOA_RAW = "ns1.example.com. hostmaster.example.com. 2026100407 10800 3600 604800 3600";
const SOA_EDITED = "ns1.example.com. hostmaster.example.com. 2026103368 10800 3600 604800 3600";

const primary = [
  rr("example.com.", "SOA", SOA_RAW),
  rr("example.com.", "NS", "ns1.example.com.", "ns2.example.com."),
  rr("www.example.com.", "A", "192.0.2.10"),
];

// What a presigned PowerDNS secondary stores after AXFR from a signed primary.
const presignedMirror = [
  rr("example.com.", "SOA", SOA_EDITED),
  rr("example.com.", "NS", "ns1.example.com.", "ns2.example.com."),
  rr("www.example.com.", "A", "192.0.2.10"),
  rr("example.com.", "DNSKEY", "257 3 13 AAAA"),
  rr("example.com.", "CDS", "12345 13 2 ABCD"),
  rr("example.com.", "CDNSKEY", "257 3 13 AAAA"),
  rr("example.com.", "NSEC", "www.example.com. A NS SOA RRSIG NSEC DNSKEY CDS CDNSKEY"),
  rr("example.com.", "RRSIG", "SOA 13 2 3600 x", "NS 13 2 3600 x", "DNSKEY 13 2 3600 x"),
  rr("www.example.com.", "RRSIG", "A 13 3 3600 x"),
];

describe("diffZoneRecords", () => {
  it("signed primary vs presigned mirror: no drift (#146)", () => {
    const d = diffZoneRecords(primary, presignedMirror, { signed: true });
    expect(d.onlyOnPrimary).toEqual([]);
    expect(d.onlyOnSecondary).toEqual([]);
    expect(d.presignedRecords).toBe(8);
  });

  it("unsigned primary: DNSSEC records on the mirror ARE drift", () => {
    const d = diffZoneRecords(primary, presignedMirror, { signed: false });
    expect(d.onlyOnSecondary.some((l) => l.includes("\tRRSIG\t"))).toBe(true);
    expect(d.presignedRecords).toBe(0);
  });

  it("SOA compared without its serial, other SOA fields still compared", () => {
    expect(diffZoneRecords([primary[0]!], [rr("example.com.", "SOA", SOA_EDITED)])).toMatchObject({
      onlyOnPrimary: [],
      onlyOnSecondary: [],
    });
    const changedRefresh = SOA_EDITED.replace(" 10800 ", " 7200 ");
    const d = diffZoneRecords([primary[0]!], [rr("example.com.", "SOA", changedRefresh)]);
    expect(d.onlyOnPrimary).toHaveLength(1);
    expect(d.onlyOnSecondary).toHaveLength(1);
  });

  it("real record drift is still reported on a signed zone", () => {
    const mirror = presignedMirror.map((r) =>
      r.type === "A" ? rr("www.example.com.", "A", "192.0.2.99") : r,
    );
    const d = diffZoneRecords(primary, mirror, { signed: true });
    expect(d.onlyOnPrimary).toEqual(["www.example.com.\t3600\tIN\tA\t192.0.2.10"]);
    expect(d.onlyOnSecondary).toEqual(["www.example.com.\t3600\tIN\tA\t192.0.2.99"]);
  });

  it("TXT chunking differences are not drift", () => {
    const d = diffZoneRecords(
      [rr("example.com.", "TXT", '"v=spf1 include:example.net -all"')],
      [rr("example.com.", "TXT", '"v=spf1 include:" "example.net -all"')],
    );
    expect(d.onlyOnPrimary).toEqual([]);
    expect(d.onlyOnSecondary).toEqual([]);
  });
});

describe("maskSoaSerial", () => {
  it("masks only the serial", () => {
    expect(maskSoaSerial(SOA_RAW)).toBe(
      "ns1.example.com. hostmaster.example.com. <serial> 10800 3600 604800 3600",
    );
  });

  it("leaves malformed content alone", () => {
    expect(maskSoaSerial("not an soa")).toBe("not an soa");
  });
});
