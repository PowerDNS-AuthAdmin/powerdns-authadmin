/**
 * tests/integration/dns/dnssec.test.ts
 *
 * Proves DNSSEC works end-to-end through the app:
 *
 *   1. Standalone primary — the app secures a zone via the cryptokeys API
 *      (a CSK), and the zone is then served SIGNED: a DNSKEY at the apex and
 *      an RRSIG over the A/SOA answers (online signing), while plain
 *      resolution still works.
 *
 *   2. Primary + Secondary — a secured primary's zone transfers to a
 *      supermaster Secondary via AXFR as a *presigned* zone, so the Secondary
 *      serves the same record WITH its RRSIG (it holds no keys of its own).
 *
 * Requires DNSSEC enabled on the backends (docker/pdns/*.conf:
 * `g*-dnssec=yes`). The DNS ports are published per docker-compose-combined.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";
import { DNS_PORTS, hasDnskey, hasRrsig, pollDns, resolverFor } from "../helpers/dns";

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

const q = (fqdn: string): string => fqdn.replace(/\.$/, "");

async function createZone(
  admin: TestHttp,
  serverSlug: string,
  name: string,
  nameservers: string[],
): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug,
    name,
    kind: "Master",
    nameservers,
  });
}

async function upsertA(
  admin: TestHttp,
  serverSlug: string,
  zone: string,
  name: string,
  ip: string,
): Promise<void> {
  await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    serverSlug,
    changes: [{ kind: "upsert", name, type: "A", ttl: 60, records: [{ content: ip }] }],
  });
}

interface CryptokeyResp {
  ok: boolean;
  cryptokey: { id: number; keytype: string; active: boolean };
}

/** Secure a zone by generating an active CSK via the app's cryptokeys API. */
async function secureZone(
  admin: TestHttp,
  serverSlug: string,
  zone: string,
): Promise<CryptokeyResp> {
  return admin.sendJson<CryptokeyResp>(
    "POST",
    `/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`,
    { serverSlug, keytype: "csk", algorithm: "ecdsa256", active: true },
  );
}

describe("DNSSEC end-to-end", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("standalone: securing a zone serves DNSKEY + RRSIG and still resolves", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec");
    const port = DNS_PORTS.standalone;
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    const name = `www.${zone}`;
    await upsertA(admin, "standalone", zone, name, "192.0.2.40");

    const created = await secureZone(admin, "standalone", zone);
    expect(created.ok).toBe(true);
    expect(created.cryptokey.keytype).toBe("csk");
    expect(created.cryptokey.active).toBe(true);

    // Re-touch a record so PDNS bumps the serial + rectifies the now-secured zone.
    await upsertA(admin, "standalone", zone, name, "192.0.2.41");

    // Apex now serves a DNSKEY (zone is signed).
    await pollDns(() => hasDnskey(zone, port), { label: "DNSKEY at apex", timeoutMs: 30_000 });

    // The A answer carries an RRSIG, and plain resolution still returns the value.
    await pollDns(() => hasRrsig(name, "A", port), { label: "RRSIG over A", timeoutMs: 30_000 });
    const r = resolverFor(port);
    const ips = await pollDns(
      async () => {
        const got = await r.resolve4(q(name));
        return got.includes("192.0.2.41") ? got : null;
      },
      { label: "A resolves on signed zone" },
    );
    expect(ips).toContain("192.0.2.41");

    // SOA is signed too.
    expect(await hasRrsig(zone, "SOA", port)).toBe(true);
  }, 60_000);

  it("primary→secondary: a signed zone transfers presigned and the secondary serves the RRSIG", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-ps");
    const primaryPort = DNS_PORTS.psPrimary;
    const secondaryPort = DNS_PORTS.psSecondary1;
    // NS must list the secondaries' supermaster hostnames so PDNS' auto-
    // secondary verification accepts the NOTIFY and AXFRs the zone.
    const ns = ["pdns-ps-secondary-1.", "pdns-ps-secondary-2.", "pdns-ps-secondary-3."];
    await createZone(admin, "ps-primary", zone, ns);
    const name = `www.${zone}`;
    await upsertA(admin, "ps-primary", zone, name, "192.0.2.50");

    await secureZone(admin, "ps-primary", zone);
    // Bump the serial post-secure so the primary NOTIFYs and the secondary
    // pulls the SIGNED version of the zone.
    await upsertA(admin, "ps-primary", zone, name, "192.0.2.51");

    // Primary serves it signed.
    await pollDns(() => hasDnskey(zone, primaryPort), {
      label: "primary DNSKEY",
      timeoutMs: 30_000,
    });
    await pollDns(() => hasRrsig(name, "A", primaryPort), {
      label: "primary RRSIG/A",
      timeoutMs: 30_000,
    });

    // Secondary picks up the presigned zone via AXFR (NOTIFY + 15s xfr cycle).
    const secResolver = resolverFor(secondaryPort);
    const ips = await pollDns(
      async () => {
        const got = await secResolver.resolve4(q(name));
        return got.includes("192.0.2.51") ? got : null;
      },
      { label: "secondary resolves www", timeoutMs: 60_000, intervalMs: 2000 },
    );
    expect(ips).toContain("192.0.2.51");

    // …and serves the signature it received (it holds no keys itself).
    await pollDns(() => hasRrsig(name, "A", secondaryPort), {
      label: "secondary RRSIG/A",
      timeoutMs: 60_000,
      intervalMs: 2000,
    });
    expect(await hasDnskey(zone, secondaryPort)).toBe(true);
  }, 120_000);
});
