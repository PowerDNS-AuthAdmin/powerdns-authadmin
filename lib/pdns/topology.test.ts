import { describe, expect, it } from "vitest";
import {
  advertisedAddressesFor,
  hostFromUrl,
  normalizeMaster,
  resolveUpstreams,
  type TopologyBackend,
} from "./topology";

describe("hostFromUrl", () => {
  it("extracts the bare host, lowercased, brackets stripped", () => {
    expect(hostFromUrl("http://pdns-primary:8081/api/v1")).toBe("pdns-primary");
    expect(hostFromUrl("https://NS1.Example.com/api/v1")).toBe("ns1.example.com");
    expect(hostFromUrl("http://[2001:db8::1]:8081/api/v1")).toBe("2001:db8::1");
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("normalizeMaster", () => {
  it("strips port, tsig suffix, and IPv6 brackets", () => {
    expect(normalizeMaster("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeMaster("192.0.2.1:5300")).toBe("192.0.2.1");
    expect(normalizeMaster("192.0.2.1:53;mykey")).toBe("192.0.2.1");
    expect(normalizeMaster("[2001:db8::1]:53")).toBe("2001:db8::1");
    expect(normalizeMaster("PDNS-Primary")).toBe("pdns-primary");
  });

  it("keeps a bare (unbracketed) IPv6 intact", () => {
    expect(normalizeMaster("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("advertisedAddressesFor", () => {
  it("falls back to the URL host when no explicit addresses are set", () => {
    expect(
      advertisedAddressesFor({ baseUrl: "http://ns1:8081/api/v1", advertisedAddresses: null }),
    ).toEqual(["ns1"]);
  });

  it("uses explicit addresses (normalized) over the URL host", () => {
    expect(
      advertisedAddressesFor({
        baseUrl: "http://ns1:8081/api/v1",
        advertisedAddresses: ["192.0.2.1:53", "192.0.2.2"],
      }),
    ).toEqual(["192.0.2.1", "192.0.2.2"]);
  });
});

const backend = (over: Partial<TopologyBackend> & { id: string }): TopologyBackend => ({
  name: over.id,
  slug: over.id,
  baseUrl: `http://${over.id}:8081/api/v1`,
  advertisedAddresses: null,
  ...over,
});

describe("resolveUpstreams", () => {
  const primary = backend({ id: "primary", advertisedAddresses: ["192.0.2.10"] });
  const other = backend({ id: "other", advertisedAddresses: ["192.0.2.20"] });

  it("matches a master IP to the managed backend that advertises it", () => {
    const { matched, external } = resolveUpstreams(["192.0.2.10:53"], [primary, other]);
    expect(matched.map((b) => b.id)).toEqual(["primary"]);
    expect(external).toEqual([]);
  });

  it("matches a hidden primary by AXFR address, not NS membership", () => {
    // The "primary" need not appear in any NS record - matching is purely on
    // the advertised AXFR address.
    const { matched } = resolveUpstreams(["192.0.2.10"], [primary]);
    expect(matched.map((b) => b.id)).toEqual(["primary"]);
  });

  it("reports an unmatched master as external, never a false orphan", () => {
    const { matched, external } = resolveUpstreams(["198.51.100.1"], [primary, other]);
    expect(matched).toEqual([]);
    expect(external).toEqual(["198.51.100.1"]);
  });

  it("matches the URL host when no explicit advertised address is set", () => {
    const byHost = backend({ id: "pdns-ps-primary" }); // advertised falls back to host
    const { matched } = resolveUpstreams(["pdns-ps-primary:53"], [byHost]);
    expect(matched.map((b) => b.id)).toEqual(["pdns-ps-primary"]);
  });

  it("dedupes repeated masters + handles mixed matched/external", () => {
    const { matched, external } = resolveUpstreams(
      ["192.0.2.10", "192.0.2.10", "198.51.100.9", "198.51.100.9"],
      [primary, other],
    );
    expect(matched.map((b) => b.id)).toEqual(["primary"]);
    expect(external).toEqual(["198.51.100.9"]);
  });
});
