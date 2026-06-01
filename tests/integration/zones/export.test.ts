/**
 * tests/integration/zones/export.test.ts
 *
 * GET /api/admin/pdns/zones/[zoneId]/export - render the zone as a
 * BIND-format text file. We seed a couple of RRsets via the rrsets
 * route, then export and check the output contains the SOA, NS, and
 * the records we added.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `export-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

describe("GET /api/admin/pdns/zones/[zoneId]/export", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("returns text/plain with SOA + NS records of the zone", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/export?serverSlug=standalone`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("SOA");
    expect(body).toContain("NS");
    expect(body).toContain(zone);
    expect(body).toContain("ns1.example.com.");
  }, 15_000);

  it("includes RRsets added after creation", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const rrName = `www.${zone}`;
    await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      serverSlug: "standalone",
      changes: [
        {
          kind: "upsert",
          name: rrName,
          type: "A",
          ttl: 300,
          records: [{ content: "192.0.2.42" }],
        },
      ],
    });
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/export?serverSlug=standalone`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("192.0.2.42");
    // Owner is relativised against $ORIGIN - `www.<zone>` becomes `www`,
    // with `$ORIGIN <zone>` above. Assert both halves so a future
    // regression that omits $ORIGIN would still be caught.
    expect(body).toContain(`$ORIGIN ${zone}`);
    expect(body).toMatch(/^www\s/m);
  }, 15_000);

  it("sets a Content-Disposition attachment header with the zone filename", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/export?serverSlug=standalone`,
    );
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/attachment;\s*filename=/);
    // Trailing dot is stripped before going into the filename.
    expect(disposition).toContain(zone.replace(/\.$/, ""));
  }, 15_000);

  it("returns 404 for a zone that doesn't exist on the backend", async () => {
    const admin = await loginAsBootstrap();
    const fake = randomZone();
    const res = await admin.call(
      `/api/admin/pdns/zones/${encodeURIComponent(fake)}/export?serverSlug=standalone`,
    );
    expect(res.status).toBe(404);
  }, 15_000);
});
