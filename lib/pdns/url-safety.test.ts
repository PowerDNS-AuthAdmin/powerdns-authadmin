/**
 * lib/pdns/url-safety.test.ts
 *
 * Unit tests for the SSRF guard. These are pure address-classification tests
 * - no DNS - so they exercise both the IPv4 and IPv6 bitwise math paths and
 * the always-blocked / private-network policy split.
 */

import { describe, expect, it } from "vitest";
import { checkPdnsUrlSafe } from "./url-safety";

describe("checkPdnsUrlSafe - always-blocked ranges", () => {
  it("rejects IPv4 link-local (169.254.x.x / cloud metadata)", async () => {
    const result = await checkPdnsUrlSafe("http://169.254.169.254/latest/meta-data", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toMatch(/never allowed/i);
  });

  it("rejects IPv6 link-local (fe80::/10)", async () => {
    const result = await checkPdnsUrlSafe("http://[fe80::1]/", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects IPv4 multicast (224.0.0.0/4)", async () => {
    const result = await checkPdnsUrlSafe("http://239.1.1.1/", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects IPv4 unspecified 0.0.0.0", async () => {
    const result = await checkPdnsUrlSafe("http://0.0.0.0/", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
  });
});

describe("checkPdnsUrlSafe - private-network gating", () => {
  it("rejects 127.0.0.1 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://127.0.0.1:8081/api/v1", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toMatch(/private/i);
  });

  it("allows 127.0.0.1 when private allowed", async () => {
    const result = await checkPdnsUrlSafe("http://127.0.0.1:8081/api/v1", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(true);
  });

  it("rejects RFC1918 10/8 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://10.0.0.5/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects RFC1918 172.16/12 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://172.20.0.5/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("allows 172.15.0.5 (outside RFC1918) regardless", async () => {
    const result = await checkPdnsUrlSafe("http://172.15.0.5/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(true);
  });

  it("rejects RFC1918 192.168/16 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://192.168.1.1/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects CGNAT 100.64/10 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://100.64.0.1/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects IPv6 loopback ::1 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://[::1]/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("rejects IPv6 ULA fc00::/7 when private not allowed", async () => {
    const result = await checkPdnsUrlSafe("http://[fc00::1]/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });
});

describe("checkPdnsUrlSafe - globally-routable addresses", () => {
  it("allows a globally routable IPv4 literal", async () => {
    const result = await checkPdnsUrlSafe("https://8.8.8.8/api/v1", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(true);
  });

  it("allows a globally routable IPv6 literal", async () => {
    const result = await checkPdnsUrlSafe("https://[2606:4700:4700::1111]/api/v1", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(true);
  });
});

describe("checkPdnsUrlSafe - IPv4-mapped IPv6 escape attempts", () => {
  it("classifies ::ffff:127.0.0.1 as private (escape via v6 form)", async () => {
    const result = await checkPdnsUrlSafe("http://[::ffff:127.0.0.1]/", {
      allowPrivateNetworks: false,
    });
    expect(result.safe).toBe(false);
  });

  it("classifies ::ffff:169.254.169.254 as always-blocked", async () => {
    const result = await checkPdnsUrlSafe("http://[::ffff:169.254.169.254]/", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toMatch(/never allowed/i);
  });
});

describe("checkPdnsUrlSafe - URL shape", () => {
  it("rejects non-http schemes", async () => {
    const result = await checkPdnsUrlSafe("ftp://example.com/", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toMatch(/http/i);
  });

  it("rejects malformed URLs", async () => {
    const result = await checkPdnsUrlSafe("not a url", {
      allowPrivateNetworks: true,
    });
    expect(result.safe).toBe(false);
  });
});
