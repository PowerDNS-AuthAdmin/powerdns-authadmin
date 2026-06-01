/**
 * tests/integration/zones/metadata.test.ts
 *
 * PUT/DELETE /api/admin/pdns/zones/[zoneId]/metadata/[kind] - per-kind
 * zone metadata. The route accepts PUT for upsert and DELETE for
 * removal; the app has no GET on this path, so we verify with the
 * PowerDNS Authoritative API directly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `meta-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

async function pdnsGetMetadata(
  zone: string,
  kind: string,
): Promise<{ kind: string; metadata: string[] } | null> {
  const backend = PDNS_BY_TOPOLOGY.standalone;
  const res = await fetch(`${backend.baseUrl}/servers/localhost/zones/${zone}/metadata/${kind}`, {
    headers: { "x-api-key": backend.apiKey },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pdns get metadata → ${res.status}`);
  return (await res.json()) as { kind: string; metadata: string[] };
}

describe("zone metadata PUT/DELETE", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("a freshly-created zone has empty metadata for ALLOW-AXFR-FROM", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const meta = await pdnsGetMetadata(zone, "ALLOW-AXFR-FROM");
    expect(meta?.metadata ?? []).toEqual([]);
  }, 15_000);

  it("PUT sets the metadata kind and PDNS confirms the value", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const cidr = "192.0.2.0/24";
    const res = await admin.sendJson<{ metadata: { kind: string; metadata: string[] } }>(
      "PUT",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/ALLOW-AXFR-FROM`,
      { serverSlug: "standalone", values: [cidr] },
    );
    expect(res.metadata.metadata).toContain(cidr);
    const live = await pdnsGetMetadata(zone, "ALLOW-AXFR-FROM");
    expect(live?.metadata).toEqual([cidr]);
  }, 15_000);

  it("PUT replaces the metadata values when called twice", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const url = `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/ALLOW-AXFR-FROM`;
    await admin.sendJson("PUT", url, { serverSlug: "standalone", values: ["10.0.0.0/8"] });
    await admin.sendJson("PUT", url, {
      serverSlug: "standalone",
      values: ["172.16.0.0/12", "192.0.2.0/24"],
    });
    const live = await pdnsGetMetadata(zone, "ALLOW-AXFR-FROM");
    expect(live?.metadata?.sort()).toEqual(["172.16.0.0/12", "192.0.2.0/24"]);
  }, 15_000);

  it("DELETE removes the metadata kind", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const url = `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/ALLOW-AXFR-FROM`;
    await admin.sendJson("PUT", url, { serverSlug: "standalone", values: ["10.0.0.0/8"] });
    await admin.sendJson("DELETE", `${url}?serverSlug=standalone`);
    const live = await pdnsGetMetadata(zone, "ALLOW-AXFR-FROM");
    expect(live?.metadata ?? []).toEqual([]);
  }, 15_000);

  it("rejects an invalid metadata kind (lowercase letters) with 400", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/not-uppercase`,
      { method: "PUT", json: { serverSlug: "standalone", values: ["x"] } },
    );
    expect(res.status).toBe(400);
  }, 15_000);
});
