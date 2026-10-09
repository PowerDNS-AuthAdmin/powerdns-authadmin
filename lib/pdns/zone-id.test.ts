import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { pdnsZoneIdForName } from "./zone-id";

describe("pdnsZoneIdForName", () => {
  it("leaves ordinary zone names untouched (the id is the name)", () => {
    expect(pdnsZoneIdForName("example.com.")).toBe("example.com.");
    expect(pdnsZoneIdForName("sub-zone.example.com.")).toBe("sub-zone.example.com.");
    expect(pdnsZoneIdForName("2.0.192.in-addr.arpa.")).toBe("2.0.192.in-addr.arpa.");
  });

  it("escapes the RFC 2317 slash the way PowerDNS does", () => {
    expect(pdnsZoneIdForName("0/25.2.0.192.in-addr.arpa.")).toBe("0=2F25.2.0.192.in-addr.arpa.");
  });

  it("escapes other non-safe bytes as uppercase =XX, including the escape character", () => {
    expect(pdnsZoneIdForName("_acme.example.")).toBe("=5Facme.example.");
    expect(pdnsZoneIdForName("a=b.example.")).toBe("a=3Db.example.");
    expect(pdnsZoneIdForName("*.example.")).toBe("=2A.example.");
  });

  it("adds the trailing dot and spells the root zone =2E", () => {
    expect(pdnsZoneIdForName("example.com")).toBe("example.com.");
    expect(pdnsZoneIdForName(".")).toBe("=2E");
    expect(pdnsZoneIdForName("")).toBe("=2E");
  });

  it("never emits a byte outside PowerDNS' safe set plus '=' (fuzz)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (name) => {
        const id = pdnsZoneIdForName(name);
        expect(/^[A-Za-z0-9.=-]+$/.test(id)).toBe(true);
        expect(id.endsWith(".") || id === "=2E").toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
