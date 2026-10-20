import { describe, expect, it } from "vitest";
import {
  canonicalZone,
  expandIpv6,
  findReverseZone,
  parseIpv4,
  reverseOwnerName,
  sameAddress,
} from "./reverse-name";

describe("parseIpv4", () => {
  it("accepts dotted quads and rejects everything else", () => {
    expect(parseIpv4("192.0.2.1")).toEqual([192, 0, 2, 1]);
    expect(parseIpv4(" 10.0.0.255 ")).toEqual([10, 0, 0, 255]);
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("01.2.3.4")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("example.com")).toBeNull();
  });
});

describe("expandIpv6", () => {
  it("expands compressed forms to 32 nibbles", () => {
    expect(expandIpv6("2001:db8::1")).toBe("20010db8000000000000000000000001");
    expect(expandIpv6("2001:DB8:0:0:0:0:0:1")).toBe("20010db8000000000000000000000001");
    expect(expandIpv6("::1")).toBe("00000000000000000000000000000001");
    expect(expandIpv6("::")).toBe("00000000000000000000000000000000");
    expect(expandIpv6("fe80::")).toBe("fe800000000000000000000000000000");
    expect(expandIpv6("1:2:3:4:5:6:7:8")).toBe("00010002000300040005000600070008");
  });

  it("handles an embedded IPv4 tail", () => {
    expect(expandIpv6("::ffff:192.0.2.1")).toBe("00000000000000000000ffffc0000201");
    expect(expandIpv6("64:ff9b::192.0.2.33")).toBe("0064ff9b0000000000000000c0000221");
    expect(expandIpv6("1:2:3:4:5:6:192.0.2.1")).toBe("000100020003000400050006c0000201");
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      ":::1",
      "1::2::3",
      "12345::",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "fe80::1%eth0",
      "192.0.2.1",
      "g::1",
      "::ffff:999.0.0.1",
      "1:2:3:4:5:6:7:192.0.2.1",
    ]) {
      expect(expandIpv6(bad), bad).toBeNull();
    }
  });
});

describe("reverseOwnerName", () => {
  it("reverses IPv4 into in-addr.arpa", () => {
    expect(reverseOwnerName("192.0.2.1")).toBe("1.2.0.192.in-addr.arpa.");
  });
  it("reverses IPv6 nibble by nibble into ip6.arpa", () => {
    expect(reverseOwnerName("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.",
    );
  });
  it("returns null for non-addresses", () => {
    expect(reverseOwnerName("host.example.com.")).toBeNull();
    expect(reverseOwnerName("")).toBeNull();
  });
});

describe("findReverseZone", () => {
  it("picks the most specific hosted IPv4 zone", () => {
    const zones = ["example.com.", "192.in-addr.arpa.", "2.0.192.in-addr.arpa.", "in-addr.arpa."];
    expect(findReverseZone("192.0.2.7", zones)).toEqual({
      zone: "2.0.192.in-addr.arpa.",
      owner: "7.2.0.192.in-addr.arpa.",
      classless: false,
    });
    expect(findReverseZone("192.0.3.7", zones)).toEqual({
      zone: "192.in-addr.arpa.",
      owner: "7.3.0.192.in-addr.arpa.",
      classless: false,
    });
    expect(findReverseZone("10.0.0.1", zones)).toEqual({
      zone: "in-addr.arpa.",
      owner: "1.0.0.10.in-addr.arpa.",
      classless: false,
    });
    expect(findReverseZone("10.0.0.1", ["example.com."])).toBeNull();
  });

  it("is case- and trailing-dot-insensitive about the hosted names", () => {
    expect(findReverseZone("192.0.2.7", ["2.0.192.IN-ADDR.ARPA"])?.zone).toBe(
      "2.0.192.in-addr.arpa.",
    );
  });

  it("prefers an RFC 2317 classless zone over its /24 parent", () => {
    const zones = [
      "2.0.192.in-addr.arpa.",
      "0/25.2.0.192.in-addr.arpa.",
      "128-255.2.0.192.in-addr.arpa.",
    ];
    expect(findReverseZone("192.0.2.5", zones)).toEqual({
      zone: "0/25.2.0.192.in-addr.arpa.",
      owner: "5.0/25.2.0.192.in-addr.arpa.",
      classless: true,
    });
    expect(findReverseZone("192.0.2.200", zones)).toEqual({
      zone: "128-255.2.0.192.in-addr.arpa.",
      owner: "200.128-255.2.0.192.in-addr.arpa.",
      classless: true,
    });
  });

  it("ignores a classless zone whose block does not contain the address", () => {
    const zones = ["0/26.2.0.192.in-addr.arpa.", "2.0.192.in-addr.arpa."];
    expect(findReverseZone("192.0.2.100", zones)).toEqual({
      zone: "2.0.192.in-addr.arpa.",
      owner: "100.2.0.192.in-addr.arpa.",
      classless: false,
    });
    // Misaligned or impossible blocks are not classless zones at all.
    expect(findReverseZone("192.0.2.5", ["1/25.2.0.192.in-addr.arpa."])).toBeNull();
    expect(findReverseZone("192.0.2.5", ["0/24.2.0.192.in-addr.arpa."])).toBeNull();
    expect(findReverseZone("192.0.2.5", ["10-5.2.0.192.in-addr.arpa."])).toBeNull();
  });

  it("prefers the smaller of two overlapping classless blocks", () => {
    const zones = ["0/25.2.0.192.in-addr.arpa.", "0/28.2.0.192.in-addr.arpa."];
    expect(findReverseZone("192.0.2.3", zones)?.zone).toBe("0/28.2.0.192.in-addr.arpa.");
    expect(findReverseZone("192.0.2.100", zones)?.zone).toBe("0/25.2.0.192.in-addr.arpa.");
  });

  it("walks ip6.arpa suffixes for IPv6", () => {
    const zones = ["8.b.d.0.1.0.0.2.ip6.arpa.", "ip6.arpa."];
    expect(findReverseZone("2001:db8:1::5", zones)).toEqual({
      zone: "8.b.d.0.1.0.0.2.ip6.arpa.",
      owner: "5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.",
      classless: false,
    });
    expect(findReverseZone("2001:db9::5", zones)?.zone).toBe("ip6.arpa.");
    expect(findReverseZone("2001:db8::5", ["2.0.192.in-addr.arpa."])).toBeNull();
  });

  it("never matches a forward zone, even one that ends in arpa-like labels", () => {
    expect(findReverseZone("192.0.2.1", ["in-addr.arpa.example.com."])).toBeNull();
  });
});

describe("sameAddress / canonicalZone", () => {
  it("compares addresses structurally", () => {
    expect(sameAddress("2001:db8::1", "2001:DB8:0:0:0:0:0:1")).toBe(true);
    expect(sameAddress("192.0.2.1", "192.0.2.1 ")).toBe(true);
    expect(sameAddress("192.0.2.1", "::ffff:192.0.2.1")).toBe(false);
    expect(sameAddress("not-an-ip", "not-an-ip")).toBe(true);
  });
  it("canonicalises zone spelling", () => {
    expect(canonicalZone("Example.COM")).toBe("example.com.");
    expect(canonicalZone("example.com..")).toBe("example.com.");
  });
});

describe("ipFromReverseOwner", () => {
  it("recovers IPv4 addresses, including RFC 2317 owners", async () => {
    const { ipFromReverseOwner } = await import("./reverse-name");
    expect(ipFromReverseOwner("1.2.0.192.in-addr.arpa.")).toBe("192.0.2.1");
    expect(ipFromReverseOwner("5.0/25.2.0.192.in-addr.arpa.")).toBe("192.0.2.5");
    expect(ipFromReverseOwner("200.128-255.2.0.192.IN-ADDR.ARPA")).toBe("192.0.2.200");
    expect(ipFromReverseOwner("2.0.192.in-addr.arpa.")).toBeNull();
    expect(ipFromReverseOwner("999.2.0.192.in-addr.arpa.")).toBeNull();
  });
  it("recovers IPv6 addresses from 32 nibbles", async () => {
    const { ipFromReverseOwner, sameAddress } = await import("./reverse-name");
    const owner = "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.";
    const ip = ipFromReverseOwner(owner);
    expect(ip).not.toBeNull();
    expect(sameAddress(ip!, "2001:db8::1")).toBe(true);
    expect(ipFromReverseOwner("8.b.d.0.1.0.0.2.ip6.arpa.")).toBeNull();
  });
});
