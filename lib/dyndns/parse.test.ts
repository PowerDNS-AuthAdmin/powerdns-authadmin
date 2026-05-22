import { describe, expect, it } from "vitest";
import { findLongestZoneMatch, formatResponse, parseBasicAuth, parseDynDnsRequest } from "./parse";

function url(query: string): URL {
  return new URL(`https://app.example/nic/update?${query}`);
}

describe("parseDynDnsRequest", () => {
  it("returns notfqdn when hostname is missing", () => {
    expect(parseDynDnsRequest(url(""))).toEqual({
      kind: "error",
      code: "notfqdn",
    });
  });

  it("returns numhost for a comma-separated hostname list", () => {
    expect(parseDynDnsRequest(url("hostname=a.example,b.example"))).toEqual({
      kind: "error",
      code: "numhost",
    });
  });

  it("returns notfqdn for single-label hostnames", () => {
    expect(parseDynDnsRequest(url("hostname=localhost"))).toEqual({
      kind: "error",
      code: "notfqdn",
    });
  });

  it("lowercases hostname and strips trailing dot", () => {
    expect(parseDynDnsRequest(url("hostname=Home.Example.COM."))).toEqual({
      kind: "ok",
      req: { hostname: "home.example.com", myip: null },
    });
  });

  it("treats `myip=auto` as omitted (caller derives IP)", () => {
    expect(parseDynDnsRequest(url("hostname=host.example.com&myip=auto"))).toEqual({
      kind: "ok",
      req: { hostname: "host.example.com", myip: null },
    });
  });

  it("accepts an explicit ipv4 myip", () => {
    expect(parseDynDnsRequest(url("hostname=host.example.com&myip=192.0.2.10"))).toEqual({
      kind: "ok",
      req: { hostname: "host.example.com", myip: "192.0.2.10" },
    });
  });

  it("accepts an explicit ipv6 myip", () => {
    expect(parseDynDnsRequest(url("hostname=host.example.com&myip=2001:db8::10"))).toEqual({
      kind: "ok",
      req: { hostname: "host.example.com", myip: "2001:db8::10" },
    });
  });

  it("returns dnserr for a malformed myip", () => {
    expect(parseDynDnsRequest(url("hostname=host.example.com&myip=999.999.999.999"))).toEqual({
      kind: "error",
      code: "dnserr",
    });
  });

  it("returns notfqdn for FQDN-shaped garbage with bad labels", () => {
    expect(parseDynDnsRequest(url("hostname=-bad-.example.com"))).toEqual({
      kind: "error",
      code: "notfqdn",
    });
  });
});

describe("formatResponse", () => {
  it("includes the IP for good", () => {
    expect(formatResponse("good", "192.0.2.10")).toBe("good 192.0.2.10");
  });

  it("includes the IP for nochg", () => {
    expect(formatResponse("nochg", "192.0.2.10")).toBe("nochg 192.0.2.10");
  });

  it("omits the IP for error codes even when one is supplied", () => {
    expect(formatResponse("badauth")).toBe("badauth");
    expect(formatResponse("nohost", "192.0.2.10")).toBe("nohost");
  });

  it("falls back to the bare code when good/nochg is supplied without ip", () => {
    expect(formatResponse("good")).toBe("good");
  });
});

describe("parseBasicAuth", () => {
  function basic(user: string, pass: string): string {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }

  it("decodes well-formed Basic", () => {
    expect(parseBasicAuth(basic("alice@example.com", "pda_pat_abcdef"))).toEqual({
      user: "alice@example.com",
      pass: "pda_pat_abcdef",
    });
  });

  it("is case-insensitive on the scheme name", () => {
    expect(parseBasicAuth(basic("u", "p").replace("Basic", "basic"))).toEqual({
      user: "u",
      pass: "p",
    });
  });

  it("returns null on missing header", () => {
    expect(parseBasicAuth(null)).toBeNull();
  });

  it("returns null on malformed scheme", () => {
    expect(parseBasicAuth("Bearer abc")).toBeNull();
  });

  it("returns null on missing separator", () => {
    expect(parseBasicAuth(`Basic ${Buffer.from("noseparator").toString("base64")}`)).toBeNull();
  });

  it("returns null on empty user or pass", () => {
    expect(parseBasicAuth(basic("", "p"))).toBeNull();
    expect(parseBasicAuth(basic("u", ""))).toBeNull();
  });
});

describe("findLongestZoneMatch", () => {
  const zones = ["example.com", "sub.example.com", "other.org"];

  it("matches the apex itself", () => {
    expect(findLongestZoneMatch("example.com", zones)).toBe("example.com");
  });

  it("returns the longest matching zone for nested zones", () => {
    expect(findLongestZoneMatch("host.sub.example.com", zones)).toBe("sub.example.com");
  });

  it("returns the parent zone when no nested zone matches", () => {
    expect(findLongestZoneMatch("foo.example.com", zones)).toBe("example.com");
  });

  it("returns null when nothing matches", () => {
    expect(findLongestZoneMatch("nothing.test", zones)).toBeNull();
  });

  it("does NOT match a sibling with a shared suffix", () => {
    expect(findLongestZoneMatch("evil-example.com", zones)).toBeNull();
  });
});
