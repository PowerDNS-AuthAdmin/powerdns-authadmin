/**
 * tests/integration/admin/change-log.test.ts
 *
 * The Change log page (/admin/changes): the audit log filtered to changes,
 * across every zone, and narrowed to one zone by the zone page's "Show all
 * changes" link. Its gate is global audit.read, like the Audit and Request
 * logs: a user without it - including one granted a zone - is turned away
 * before anything renders.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

async function zoneWithRecord(admin: TestHttp, tag: string): Promise<string> {
  const zone = `${tag}-${Date.now().toString(36)}.example.com.`;
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name: zone,
    kind: "Master",
    nameservers: ["ns1.example.com.", "ns2.example.com."],
  });
  await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    serverSlug: "standalone",
    changes: [
      {
        kind: "upsert",
        name: `www.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.10" }],
      },
    ],
  });
  return zone;
}

describe("Change log page", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("lists changes across zones and narrows to one zone", async () => {
    const admin = await loginAsBootstrap();
    const first = await zoneWithRecord(admin, "chg-a");
    const second = await zoneWithRecord(admin, "chg-b");

    const all = await admin.call("/admin/changes", { method: "GET" });
    expect(all.status).toBe(200);
    const allHtml = await all.text();
    expect(allHtml).toContain("Change log");
    expect(allHtml).toContain(first);
    expect(allHtml).toContain(second);

    const narrowed = await admin.call(
      `/admin/changes?${new URLSearchParams({ zone: first, server: "standalone" }).toString()}`,
      { method: "GET" },
    );
    expect(narrowed.status).toBe(200);
    const narrowedHtml = await narrowed.text();
    expect(narrowedHtml).toContain(first);
    expect(narrowedHtml).not.toContain(second);
  }, 60_000);

  it("turns away users without global audit.read, including zone-grant holders", async () => {
    const admin = await loginAsBootstrap();
    const zone = await zoneWithRecord(admin, "chg-rbac");

    const { client: nobody } = await createAndLogin(admin, {
      email: uniqueEmail("chg-nobody"),
      name: "Change log nobody",
      password: "chg-nobody-test-pw-1234",
    });
    const denied = await nobody.call("/admin/changes", { method: "GET" });
    expect(denied.status).toBeGreaterThanOrEqual(300);
    expect(denied.status).toBeLessThan(400);
    expect(denied.headers.get("location") ?? "").not.toContain("/admin/changes");

    const { client: granted, user } = await createAndLogin(admin, {
      email: uniqueEmail("chg-granted"),
      name: "Change log granted",
      password: "chg-granted-test-pw-1234",
    });
    const [server] = await dbQuery<{ id: string }>(
      "SELECT id FROM pdns_servers WHERE slug = 'standalone'",
    );
    await admin.sendJson("POST", `/api/admin/users/${user.id}/zone-grants`, {
      serverId: server!.id,
      zoneName: zone,
      permissions: ["zone.read", "record.read"],
    });
    const grantDenied = await granted.call(
      `/admin/changes?${new URLSearchParams({ zone, server: "standalone" }).toString()}`,
      { method: "GET" },
    );
    expect(grantDenied.status).toBeGreaterThanOrEqual(300);
    expect(grantDenied.status).toBeLessThan(400);
    expect(await grantDenied.text()).not.toContain(zone);
  }, 60_000);
});
