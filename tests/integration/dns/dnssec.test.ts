/**
 * tests/integration/dns/dnssec.test.ts
 *
 * Proves DNSSEC works end-to-end through the app:
 *
 *   1. Standalone primary - the app secures a zone via the cryptokeys API
 *      (a CSK), and the zone is then served SIGNED: a DNSKEY at the apex and
 *      an RRSIG over the A/SOA answers (online signing), while plain
 *      resolution still works.
 *
 *   2. Primary + Secondary - a secured primary's zone transfers to a
 *      supermaster Secondary via AXFR as a *presigned* zone, so the Secondary
 *      serves the same record WITH its RRSIG (it holds no keys of its own).
 *
 *   3. The zone-level routes (issue #146 + the DNSSEC enablement work):
 *      `POST .../dnssec` signs AND rectifies (NXDOMAIN carries an NSEC proof
 *      with no further edit), sets SOA-EDIT so the served serial differs from
 *      the raw one, exposes the DS via `GET .../cryptokeys`, and the app then
 *      reports the presigned mirror in-sync (served vs. stored serial).
 *      Plus rectify, disable (confirm-gated) and the permission gate.
 *
 * Requires DNSSEC enabled on the backends (docker/pdns/*.conf:
 * `g*-dnssec=yes`). The DNS ports are published per docker-compose-combined.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";
import { createAndLogin, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import {
  DNS_PORTS,
  dnsSoaSerial,
  hasDnskey,
  hasNsecDenial,
  hasRrsig,
  pollDns,
  resolverFor,
  servesSigned,
} from "../helpers/dns";
import { getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";

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

interface DnssecStatus {
  dnssec: boolean;
  soaEdit: string;
  apiRectify: boolean | null;
  serial: number | null;
  servedSerial: number | null;
  cryptokeys: Array<{ id: number; keytype: string; active: boolean; ds: string[] }>;
  ds: string[];
  warnings: string[];
  mirrors?: Array<{ serverSlug: string; state: string; servedSerial: number | null }>;
}

const SECONDARY_NS = ["pdns-ps-secondary-1.", "pdns-ps-secondary-2.", "pdns-ps-secondary-3."];

const dnssecPath = (zone: string, query = ""): string =>
  `/api/admin/pdns/zones/${encodeURIComponent(zone)}/dnssec${query}`;

describe("zone-level DNSSEC routes", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("enable: signs + rectifies, DS readable, presigned mirror reported in-sync", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-enable");
    await createZone(admin, "ps-primary", zone, SECONDARY_NS);
    const name = `www.${zone}`;
    await upsertA(admin, "ps-primary", zone, name, "192.0.2.60");

    // Let the secondary hold the UNSIGNED zone first - the realistic rollout.
    await pollDns(
      async () => (await resolverFor(DNS_PORTS.psSecondary1).resolve4(q(name))).length > 0,
      { label: "secondary has the unsigned zone", timeoutMs: 60_000, intervalMs: 2000 },
    );

    const res = await admin.call(dnssecPath(zone), {
      method: "POST",
      json: { serverSlug: "ps-primary" },
    });
    expect(res.status).toBe(201);
    const enabled = (await res.json()) as DnssecStatus;
    expect(enabled.dnssec).toBe(true);
    expect(enabled.soaEdit).toBe("INCREMENT-WEEKS");
    expect(enabled.apiRectify).toBe(true);
    expect(enabled.cryptokeys.length).toBeGreaterThan(0);
    expect(enabled.ds.length).toBeGreaterThan(0);
    // No SHA-1 (digest type 1) in the set handed to the registrar.
    expect(enabled.ds.every((d) => d.split(/\s+/)[2] !== "1")).toBe(true);

    // SOA-EDIT makes the served serial differ from the stored one - the exact
    // shape that used to read as DESYNCED (#146). PowerDNS may keep applying
    // its cached (empty) SOA-EDIT for up to zone-metadata-cache-ttl (60 s),
    // and 4.6-4.8 don't clear that cache on a zone PUT, so wait it out.
    const served = await pollDns(
      async () => {
        const s = await admin.getJson<DnssecStatus>(dnssecPath(zone, "?serverSlug=ps-primary"));
        return s.servedSerial !== null && s.servedSerial !== s.serial ? s.servedSerial : null;
      },
      { label: "served serial reflects SOA-EDIT", timeoutMs: 90_000, intervalMs: 2000 },
    );

    // Rectified by the enable itself - no record edit after signing.
    await pollDns(() => hasNsecDenial(zone, DNS_PORTS.psPrimary), {
      label: "primary NSEC denial",
      timeoutMs: 30_000,
    });

    // DS is readable through the API (what a PAT client hands the registrar).
    const keys = await admin.getJson<{ ds: string[]; cryptokeys: Array<{ dnskey: string }> }>(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys?serverSlug=ps-primary`,
    );
    expect(keys.ds).toEqual(enabled.ds);
    expect(keys.cryptokeys[0]?.dnskey).toMatch(/^257 3 /);
    expect(JSON.stringify(keys)).not.toMatch(/privatekey/i);

    // The secondary re-transfers the signed zone (serial bump + NOTIFY),
    // stores the SERVED serial, and serves it signed. One predicate under one
    // budget, gated on what DNS actually answers: the API reports the new
    // serial the moment the AXFR transaction commits, before the daemon has
    // purged its packet cache and finished the ordername fix-up on the
    // presigned copy, so gating on the API and then giving each DNS check its
    // own short window failed slow-but-correct runs on whichever phase drew
    // the short straw. On versions that kept the stale SOA-EDIT, the first
    // NOTIFY carried the old serial; the route's follow-up NOTIFY (after the
    // metadata cache TTL) brings the secondary to the served one.
    const secondary = PDNS_BY_TOPOLOGY.psSecondaries[0]!;
    await pollDns(
      async () =>
        (await getZone(secondary, zone)).serial === served &&
        (await dnsSoaSerial(zone, DNS_PORTS.psSecondary1)) === served &&
        (await servesSigned(zone, name, DNS_PORTS.psSecondary1)),
      {
        label: "secondary serves the signed zone at the served serial",
        timeoutMs: 180_000,
        intervalMs: 2000,
      },
    );

    // …and the app compares served vs. stored: in-sync, not "ahead".
    const status = await pollDns(
      async () => {
        const s = await admin.getJson<DnssecStatus>(dnssecPath(zone, "?serverSlug=ps-primary"));
        const mirrors = s.mirrors ?? [];
        return mirrors.length > 0 && mirrors.every((m) => m.state === "in-sync") ? s : null;
      },
      { label: "app reports mirrors in-sync", timeoutMs: 90_000, intervalMs: 3000 },
    );
    expect(status.mirrors?.every((m) => m.servedSerial === served)).toBe(true);

    // Enabling again is idempotent.
    const again = await admin.call(dnssecPath(zone), {
      method: "POST",
      json: { serverSlug: "ps-primary" },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { alreadyEnabled: boolean }).alreadyEnabled).toBe(true);
  }, 420_000);

  it("a key added via POST /cryptokeys is rectified too", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-key");
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    await upsertA(admin, "standalone", zone, `www.${zone}`, "192.0.2.70");

    const created = await admin.sendJson<{ rectified: boolean }>(
      "POST",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/cryptokeys`,
      { serverSlug: "standalone", keytype: "csk", algorithm: "ecdsa256", active: true },
    );
    expect(created.rectified).toBe(true);
    await pollDns(() => hasNsecDenial(zone, DNS_PORTS.standalone), {
      label: "NSEC denial without a record edit",
      timeoutMs: 30_000,
    });
  }, 60_000);

  it("rectify bumps the serial on a transferred zone", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-rectify");
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    await admin.sendJson("POST", dnssecPath(zone), { serverSlug: "standalone" });
    const before = await admin.getJson<DnssecStatus>(dnssecPath(zone, "?serverSlug=standalone"));

    const out = await admin.sendJson<{ ok: boolean; serialAdvance: string; servedSerial: number }>(
      "PUT",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rectify`,
      { serverSlug: "standalone" },
    );
    expect(out.ok).toBe(true);
    expect(out.serialAdvance).toBe("patched");
    expect(out.servedSerial).toBeGreaterThan(before.servedSerial ?? 0);
    expect(await hasNsecDenial(zone, DNS_PORTS.standalone)).toBe(true);
  }, 60_000);

  it("disable needs confirm=<zone>, then unsigns", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-off");
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    await admin.sendJson("POST", dnssecPath(zone), { serverSlug: "standalone" });
    await pollDns(() => hasDnskey(zone, DNS_PORTS.standalone), { label: "signed" });

    const refused = await admin.call(dnssecPath(zone, "?serverSlug=standalone"), {
      method: "DELETE",
    });
    expect(refused.status).toBe(400);

    const ok = await admin.call(
      dnssecPath(zone, `?serverSlug=standalone&confirm=${encodeURIComponent(q(zone))}`),
      { method: "DELETE" },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as DnssecStatus).dnssec).toBe(false);
    await pollDns(async () => !(await hasDnskey(zone, DNS_PORTS.standalone)), {
      label: "DNSKEY gone",
    });
  }, 60_000);

  it("GET on an unsigned zone works as a pre-flight: ALIAS records warn", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-preflight");
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      serverSlug: "standalone",
      changes: [
        {
          kind: "upsert",
          name: `app.${zone}`,
          type: "ALIAS",
          ttl: 60,
          records: [{ content: "target.example.net." }],
        },
      ],
    });
    const status = await admin.getJson<DnssecStatus>(dnssecPath(zone, "?serverSlug=standalone"));
    expect(status.dnssec).toBe(false);
    expect(status.warnings.join(" ")).toMatch(/ALIAS records/);
  }, 30_000);

  it("read-only role can read DNSSEC state but not enable it", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("dnssec-ro");
    await createZone(admin, "standalone", zone, ["ns1.example.com.", "ns2.example.com."]);
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("ro-dnssec-zone"),
      name: "Read Only",
      password: "ro-dnssec-zone-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const read = await client.call(dnssecPath(zone, "?serverSlug=standalone"));
    expect(read.status).toBe(200);
    const write = await client.call(dnssecPath(zone), {
      method: "POST",
      json: { serverSlug: "standalone" },
    });
    expect(write.status).toBe(403);
    const rectify = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rectify`, {
      method: "PUT",
      json: { serverSlug: "standalone" },
    });
    expect(rectify.status).toBe(403);
  }, 30_000);
});
