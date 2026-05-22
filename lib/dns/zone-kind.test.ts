/**
 * lib/dns/zone-kind.test.ts
 *
 * Exercises the forward / reverse-ipv4 / reverse-ipv6 classification
 * including edge cases: missing trailing dot, mixed case, the root
 * reverse trees, and "looks-like-but-isn't" names (a forward zone
 * that contains the substring `in-addr.arpa` somewhere other than
 * the suffix).
 */

import { describe, expect, it } from "vitest";
import { isReverseZone, zoneKind } from "./zone-kind";

describe("zoneKind", () => {
  it("classifies plain forward zones", () => {
    expect(zoneKind("example.com.")).toBe("forward");
    expect(zoneKind("example.com")).toBe("forward");
    expect(zoneKind("sub.example.co.uk.")).toBe("forward");
  });

  it("classifies in-addr.arpa subtrees as reverse-ipv4", () => {
    expect(zoneKind("0.168.192.in-addr.arpa.")).toBe("reverse-ipv4");
    expect(zoneKind("0.168.192.in-addr.arpa")).toBe("reverse-ipv4");
    expect(zoneKind("10.in-addr.arpa.")).toBe("reverse-ipv4");
    expect(zoneKind("in-addr.arpa.")).toBe("reverse-ipv4");
  });

  it("classifies ip6.arpa subtrees as reverse-ipv6", () => {
    expect(zoneKind("0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.")).toBe("reverse-ipv6");
    expect(zoneKind("ip6.arpa.")).toBe("reverse-ipv6");
  });

  it("is case-insensitive", () => {
    expect(zoneKind("0.168.192.IN-ADDR.ARPA.")).toBe("reverse-ipv4");
    expect(zoneKind("8.B.D.0.1.0.0.2.IP6.ARPA")).toBe("reverse-ipv6");
  });

  it('does not match "in-addr.arpa" that isn\'t at the suffix', () => {
    // Pathological forward zone that contains the substring as a label.
    expect(zoneKind("in-addr.arpa.example.com.")).toBe("forward");
  });

  it("isReverseZone agrees with zoneKind", () => {
    expect(isReverseZone("0.168.192.in-addr.arpa.")).toBe(true);
    expect(isReverseZone("example.com.")).toBe(false);
  });
});
