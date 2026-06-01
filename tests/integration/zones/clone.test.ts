/**
 * tests/integration/zones/clone.test.ts
 *
 * POST /api/admin/pdns/zones/clone - copy an existing zone's RRsets
 * into a fresh zone, dropping the SOA so PDNS regenerates one. We
 * verify the new zone exists on the same backend and carries the
 * source's records (rewritten to the new origin), but with a fresh SOA.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

interface PdnsRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string }>;
}

async function createZoneWithRecords(admin: TestHttp, zone: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name: zone,
    kind: "Master",
    nameservers: NS,
  });
  await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    serverSlug: "standalone",
    changes: [
      {
        kind: "upsert",
        name: `www.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.1" }],
      },
      {
        kind: "upsert",
        name: `api.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.2" }],
      },
    ],
  });
}

describe("POST /api/admin/pdns/zones/clone", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("clones a source zone into a new name, preserving the records", async () => {
    const admin = await loginAsBootstrap();
    const source = randomZone("src");
    const target = randomZone("dst");
    await createZoneWithRecords(admin, source);

    const res = await admin.sendJson<{ zone: { name: string; kind: string } }>(
      "POST",
      "/api/admin/pdns/zones/clone",
      { serverSlug: "standalone", sourceName: source, targetName: target },
    );
    expect(res.zone.name).toBe(target);
    expect(res.zone.kind).toBe("Master");

    const cloned = await getZone(PDNS_BY_TOPOLOGY.standalone, target);
    const rrsets = (cloned.rrsets ?? []) as PdnsRRset[];
    // The www / api A records should have been rewritten to the target origin.
    const www = rrsets.find((r) => r.name === `www.${target}` && r.type === "A");
    const api = rrsets.find((r) => r.name === `api.${target}` && r.type === "A");
    expect(www?.records.map((r) => r.content)).toEqual(["192.0.2.1"]);
    expect(api?.records.map((r) => r.content)).toEqual(["192.0.2.2"]);
    // The clone has its own SOA, not the source's.
    const soa = rrsets.find((r) => r.type === "SOA");
    expect(soa).toBeDefined();
    expect(soa!.records[0]!.content).toContain(target);
  }, 20_000);

  it("rejects cloning a zone onto itself (400)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("same");
    await createZoneWithRecords(admin, zone);
    const res = await admin.call("/api/admin/pdns/zones/clone", {
      method: "POST",
      json: { serverSlug: "standalone", sourceName: zone, targetName: zone },
    });
    expect(res.status).toBe(400);
  }, 15_000);

  it("returns 409 when the target zone already exists", async () => {
    const admin = await loginAsBootstrap();
    const source = randomZone("src2");
    const existing = randomZone("dst2");
    await createZoneWithRecords(admin, source);
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: existing,
      kind: "Master",
      nameservers: NS,
    });
    const res = await admin.call("/api/admin/pdns/zones/clone", {
      method: "POST",
      json: { serverSlug: "standalone", sourceName: source, targetName: existing },
    });
    expect(res.status).toBe(409);
  }, 15_000);
});
