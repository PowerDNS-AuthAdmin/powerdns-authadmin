/**
 * tests/integration/zones/record-wizard-api.test.ts
 *
 * The three read endpoints behind the Add record wizard and the matching MCP
 * tools: zone search across backends, "records at a name", and the per-zone
 * propagation status. Each test creates its own zone on the standalone
 * backend and reads back through the app.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

describe("record wizard APIs", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("searches zones across backends with horizon totals and permission flags", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("search");
    await createZone(admin, zone);
    // The scan is cached briefly; a fresh report read makes the new zone visible.
    await admin.call("/api/admin/pdns/auto-ptr/report?refresh=1", { method: "GET" });

    const res = await admin.call(
      `/api/admin/pdns/zones/search?q=${encodeURIComponent(zone.slice(0, 12))}`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      zones: Array<{
        name: string;
        server: string;
        horizon: string;
        reverse: boolean;
        canCreate: boolean;
      }>;
      horizons: { public: number; internal: number };
    };
    const hit = body.zones.find((z) => z.name === zone);
    expect(hit).toMatchObject({
      server: "standalone",
      horizon: "public",
      reverse: false,
      canCreate: true,
    });
    expect(body.horizons.public).toBeGreaterThanOrEqual(1);

    // A user with no roles sees nothing.
    const { client: nobody } = await createAndLogin(admin, {
      email: uniqueEmail("search-nobody"),
      name: "Search nobody",
      password: "search-nobody-test-pw-1234",
    });
    const empty = await nobody.call("/api/admin/pdns/zones/search", { method: "GET" });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { zones: unknown[] }).zones).toEqual([]);
    expect(
      (await admin.call("/api/admin/pdns/zones/search?horizon=sideways", { method: "GET" })).status,
    ).toBe(400);
  }, 60_000);

  it("reports whether records exist at a name, by type", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("records");
    await createZone(admin, zone);
    await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      serverSlug: "standalone",
      changes: [
        {
          kind: "upsert",
          name: `www.${zone}`,
          type: "A",
          ttl: 300,
          records: [{ content: "192.0.2.7" }],
          comment: "web",
        },
      ],
    });
    const base = `/api/admin/pdns/zones/${encodeURIComponent(zone)}/records?serverSlug=standalone`;
    const found = (await (await admin.call(`${base}&name=www`, { method: "GET" })).json()) as {
      name: string;
      exists: boolean;
      rrsets: Array<{
        type: string;
        ttl: number;
        records: Array<{ content: string }>;
        comment: string;
      }>;
    };
    expect(found.name).toBe(`www.${zone}`);
    expect(found.exists).toBe(true);
    expect(found.rrsets).toEqual([
      {
        name: `www.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.7", disabled: false }],
        comment: "web",
      },
    ]);
    const none = (await (
      await admin.call(`${base}&name=www&type=AAAA`, { method: "GET" })
    ).json()) as { exists: boolean };
    expect(none.exists).toBe(false);
    expect((await admin.call(`${base}&name=bad%20name`, { method: "GET" })).status).toBe(400);
  }, 60_000);

  it("describes propagation for a standalone zone as settled", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("sync");
    await createZone(admin, zone);
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/sync?serverSlug=standalone`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topology: string;
      settled: boolean;
      members: Array<{ slug: string; role: string; state: string }>;
    };
    expect(body.topology).toBe("standalone");
    expect(body.settled).toBe(true);
    expect(body.members).toEqual([
      expect.objectContaining({ slug: "standalone", role: "primary", state: "in-sync" }),
    ]);
  }, 30_000);
});
