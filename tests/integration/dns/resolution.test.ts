/**
 * tests/integration/dns/resolution.test.ts
 *
 * End-to-end DNS: the app writes records via the PDNS HTTP API, and we prove
 * they're actually SERVED over DNS by resolving against the standalone
 * primary's published port (5310). Covers create, change, multiple types, and
 * deletion (→ NXDOMAIN), so a record edit in the UI is verified all the way to
 * the wire — not just to the backend's API.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";
import { DNS_PORTS, pollDns, resolverFor } from "../helpers/dns";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;
const PORT = DNS_PORTS.standalone;
const SERVER = "standalone";

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `dns-${Date.now()}-${tag}.example.com.`;
}

/** node:dns wants names without the trailing dot. */
const q = (fqdn: string): string => fqdn.replace(/\.$/, "");

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: SERVER,
    name,
    kind: "Master",
    nameservers: NS,
  });
}

async function patch(admin: TestHttp, zone: string, changes: unknown[]): Promise<void> {
  await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    serverSlug: SERVER,
    changes,
  });
}

describe("DNS resolution (standalone primary :5310)", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("serves an A record the app upserted", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const name = `www.${zone}`;
    await patch(admin, zone, [
      { kind: "upsert", name, type: "A", ttl: 60, records: [{ content: "192.0.2.10" }] },
    ]);

    const r = resolverFor(PORT);
    const ips = await pollDns(
      async () => {
        const got = await r.resolve4(q(name));
        return got.includes("192.0.2.10") ? got : null;
      },
      { label: "A www" },
    );
    expect(ips).toContain("192.0.2.10");
  }, 30_000);

  it("reflects a changed A record over the wire", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const name = `www.${zone}`;
    const r = resolverFor(PORT);

    await patch(admin, zone, [
      { kind: "upsert", name, type: "A", ttl: 60, records: [{ content: "192.0.2.10" }] },
    ]);
    await pollDns(async () => (await r.resolve4(q(name))).includes("192.0.2.10"), {
      label: "A www v1",
    });

    await patch(admin, zone, [
      { kind: "upsert", name, type: "A", ttl: 60, records: [{ content: "192.0.2.20" }] },
    ]);
    const ips = await pollDns(
      async () => {
        const got = await r.resolve4(q(name));
        // REPLACE semantics: the old value must be gone, the new one present.
        return got.includes("192.0.2.20") && !got.includes("192.0.2.10") ? got : null;
      },
      { label: "A www v2" },
    );
    expect(ips).toEqual(["192.0.2.20"]);
  }, 30_000);

  it("serves AAAA, TXT, MX and CNAME records", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const r = resolverFor(PORT);

    await patch(admin, zone, [
      {
        kind: "upsert",
        name: `www.${zone}`,
        type: "A",
        ttl: 60,
        records: [{ content: "192.0.2.10" }],
      },
      {
        kind: "upsert",
        name: `v6.${zone}`,
        type: "AAAA",
        ttl: 60,
        records: [{ content: "2001:db8::1" }],
      },
      {
        kind: "upsert",
        name: zone,
        type: "TXT",
        ttl: 60,
        records: [{ content: '"v=spf1 -all"' }],
      },
      {
        kind: "upsert",
        name: zone,
        type: "MX",
        ttl: 60,
        records: [{ content: `10 mail.${zone}` }],
      },
      {
        kind: "upsert",
        name: `alias.${zone}`,
        type: "CNAME",
        ttl: 60,
        records: [{ content: `www.${zone}` }],
      },
    ]);

    const v6 = await pollDns(
      async () => {
        const got = await r.resolve6(q(`v6.${zone}`));
        return got.includes("2001:db8::1") ? got : null;
      },
      { label: "AAAA" },
    );
    expect(v6).toContain("2001:db8::1");

    const txt = await pollDns(
      async () => {
        const got = await r.resolveTxt(q(zone));
        const flat = got.map((chunks) => chunks.join(""));
        return flat.includes("v=spf1 -all") ? flat : null;
      },
      { label: "TXT" },
    );
    expect(txt).toContain("v=spf1 -all");

    const mx = await pollDns(
      async () => {
        const got = await r.resolveMx(q(zone));
        return got.find((m) => m.exchange === q(`mail.${zone}`) && m.priority === 10) ? got : null;
      },
      { label: "MX" },
    );
    expect(mx.some((m) => m.exchange === q(`mail.${zone}`))).toBe(true);

    const cname = await pollDns(
      async () => {
        const got = await r.resolveCname(q(`alias.${zone}`));
        return got.includes(q(`www.${zone}`)) ? got : null;
      },
      { label: "CNAME" },
    );
    expect(cname).toContain(q(`www.${zone}`));
  }, 45_000);

  it("returns NXDOMAIN after the app deletes the record", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const name = `gone.${zone}`;
    const r = resolverFor(PORT);

    await patch(admin, zone, [
      { kind: "upsert", name, type: "A", ttl: 60, records: [{ content: "192.0.2.30" }] },
    ]);
    await pollDns(async () => (await r.resolve4(q(name))).includes("192.0.2.30"), {
      label: "A before delete",
    });

    await patch(admin, zone, [{ kind: "delete", name, type: "A" }]);
    const gone = await pollDns(
      async () => {
        try {
          await r.resolve4(q(name));
          return false; // still resolving — keep polling
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          return code === "ENOTFOUND" || code === "ENODATA";
        }
      },
      { label: "A after delete" },
    );
    expect(gone).toBe(true);
  }, 30_000);
});
