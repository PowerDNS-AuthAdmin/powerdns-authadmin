/**
 * tests/integration/zones/catalog.test.ts
 *
 * Catalog zones as system zones (#209): a Producer zone can be created, a
 * content zone joins it through the settings route (which refuses a catalog
 * that isn't a Producer on the backend), and deleting a Producer with members
 * needs an explicit `confirmCatalog`. Catalog zones need PowerDNS 4.7, so the
 * suite skips on older daemons; on 4.7 and 4.8 the zone list leaves `catalog`
 * empty, which the delete guard has to see past.
 */

import { beforeAll, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { type TestHttp } from "../helpers/http";
import { loginAsBootstrap } from "../helpers/auth";
import { getServerVersion, getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomName(prefix: string, suffix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.${suffix}`;
}

async function createZone(admin: TestHttp, name: string, kind: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind,
    nameservers: kind === "Producer" ? ["invalid."] : NS,
  });
}

function setCatalog(admin: TestHttp, zone: string, catalog: string): Promise<Response> {
  return admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/settings`, {
    method: "PUT",
    json: { serverSlug: "standalone", catalog },
  });
}

function deleteZone(admin: TestHttp, zone: string, confirmCatalog?: string): Promise<Response> {
  const confirm = confirmCatalog ? `&confirmCatalog=${encodeURIComponent(confirmCatalog)}` : "";
  return admin.call(
    `/api/admin/pdns/zones/${encodeURIComponent(zone)}?serverSlug=standalone${confirm}`,
    { method: "DELETE" },
  );
}

describe("catalog zones", () => {
  let catalogsSupported = true;

  beforeAll(async () => {
    const [major, minor] = await getServerVersion(PDNS_BY_TOPOLOGY.standalone);
    catalogsSupported = major > 4 || (major === 4 && minor >= 7);
  });

  beforeEach(async (ctx: TestContext) => {
    if (!catalogsSupported) ctx.skip();
    await resetState();
  });

  it("guards deleting a Producer zone that has members", async () => {
    const admin = await loginAsBootstrap();
    const catalog = randomName("catalog", "invalid.");
    const member = randomName("member", "example.com.");
    await createZone(admin, catalog, "Producer");
    await createZone(admin, member, "Master");

    expect((await setCatalog(admin, member, catalog)).status).toBe(200);
    const stored = await getZone(PDNS_BY_TOPOLOGY.standalone, member);
    expect(stored.catalog).toBe(catalog);

    const refused = await deleteZone(admin, catalog);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; members: number };
    expect(body).toMatchObject({ error: "catalog-has-members", members: 1 });

    expect((await deleteZone(admin, catalog, catalog)).status).toBe(200);
  }, 30_000);

  it("refuses a catalog that isn't a Producer zone on the backend", async () => {
    const admin = await loginAsBootstrap();
    const member = randomName("member-bad", "example.com.");
    await createZone(admin, member, "Master");
    expect((await setCatalog(admin, member, "no-such-catalog.invalid.")).status).toBe(400);
  }, 30_000);

  it("refuses record edits on a Producer zone", async () => {
    const admin = await loginAsBootstrap();
    const catalog = randomName("catalog-ro", "invalid.");
    await createZone(admin, catalog, "Producer");
    const res = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(catalog)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${catalog}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.9" }],
          },
        ],
      },
    });
    expect(res.status).toBe(409);
  }, 30_000);
});
