/**
 * tests/integration/zones/template-apply.test.ts
 *
 * Zone-template apply path. The create route (POST /api/admin/pdns/zones)
 * accepts `templateId`; on apply, the template's nameservers, SOA
 * timers, prelude records, and metadata bag are written through to
 * PDNS. We create a custom template at test setup (the seeded
 * `standard-primary` template has a `www CNAME @` record that PDNS
 * rejects - wrong content shape - so we use our own), then create a
 * zone with it and assert the records landed on PDNS.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";
import { dbQuery } from "../helpers/db";

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `tmpl-${Date.now()}-${tag}.example.com.`;
}

interface PdnsRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string }>;
}

/** Seed a per-test template with records that PDNS accepts as-is. */
async function createTemplate(admin: TestHttp): Promise<{ id: string; slug: string }> {
  const slug = `it-tmpl-${Math.random().toString(36).slice(2, 8)}`;
  const { template } = await admin.sendJson<{
    template: { id: string; slug: string };
  }>("POST", "/api/admin/zone-templates", {
    slug,
    name: `Integration template ${slug}`,
    kind: "Master",
    nameservers: ["tns1.example.com.", "tns2.example.com."],
    records: [
      { name: "@", type: "TXT", ttl: 3600, content: '"v=spf1 -all"' },
      { name: "www", type: "A", ttl: 300, content: "192.0.2.50" },
    ],
    metadata: { "ALLOW-AXFR-FROM": ["10.0.0.0/8"] },
  });
  return template;
}

describe("zone create with templateId", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("applies the template's nameservers + records to the new zone", async () => {
    const admin = await loginAsBootstrap();
    const tmpl = await createTemplate(admin);
    const zone = randomZone();
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      templateId: tmpl.id,
    });

    const live = await getZone(PDNS_BY_TOPOLOGY.standalone, zone);
    const rrsets = (live.rrsets ?? []) as PdnsRRset[];
    const ns = rrsets.find((r) => r.name === zone && r.type === "NS");
    expect(ns).toBeDefined();
    const nsContents = ns!.records.map((r) => r.content).sort();
    expect(nsContents).toEqual(["tns1.example.com.", "tns2.example.com."]);

    const txt = rrsets.find((r) => r.name === zone && r.type === "TXT");
    expect(txt?.records[0]?.content).toBe('"v=spf1 -all"');

    const www = rrsets.find((r) => r.name === `www.${zone}` && r.type === "A");
    expect(www?.records[0]?.content).toBe("192.0.2.50");
  }, 20_000);

  it("operator-supplied nameservers override the template's NS list", async () => {
    const admin = await loginAsBootstrap();
    const tmpl = await createTemplate(admin);
    const zone = randomZone();
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: ["override-ns1.example.com.", "override-ns2.example.com."],
      templateId: tmpl.id,
    });
    const live = await getZone(PDNS_BY_TOPOLOGY.standalone, zone);
    const rrsets = (live.rrsets ?? []) as PdnsRRset[];
    const ns = rrsets.find((r) => r.name === zone && r.type === "NS");
    expect(ns!.records.map((r) => r.content).sort()).toEqual([
      "override-ns1.example.com.",
      "override-ns2.example.com.",
    ]);
  }, 20_000);

  it("rejects an unknown templateId with 400", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/pdns/zones", {
      method: "POST",
      json: {
        serverSlug: "standalone",
        name: randomZone(),
        kind: "Master",
        nameservers: ["ns1.example.com.", "ns2.example.com."],
        templateId: "11111111-1111-1111-1111-111111111111",
      },
    });
    expect(res.status).toBe(400);
  });

  it("audit log captures the template slug used at create time", async () => {
    const admin = await loginAsBootstrap();
    const tmpl = await createTemplate(admin);
    const zone = randomZone();
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      templateId: tmpl.id,
    });
    const rows = await dbQuery<{ after: { templateSlug: string } }>(
      "SELECT after FROM audit_log WHERE action = 'zone.create' AND resource_id = $1",
      [`standalone:${zone}`],
    );
    expect(rows[0]?.after?.templateSlug).toBe(tmpl.slug);
  }, 20_000);
});
