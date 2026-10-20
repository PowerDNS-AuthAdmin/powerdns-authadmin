/**
 * tests/integration/notifications/notifications-api.test.ts
 *
 * The notification list and dismiss routes apply visibility per row: backend
 * health needs server.read, a zone-monitoring finding needs zone.read on its
 * zone. A user granted one zone sees only that zone's findings and cannot
 * dismiss anything else.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface ListBody {
  summary: { active: number; dismissed: number };
  notifications: Array<{ id: string; source: string; zone: string | null; acknowledged: boolean }>;
}

async function seed(serverId: string, code: string, title: string): Promise<string> {
  // last_seen > first_seen: a confirmed advisory, the only kind the bell shows.
  const [row] = await dbQuery<{ id: string }>(
    `INSERT INTO backend_advisories
       (backend_id, code, severity, title, detail, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'warn', $3, 'Seeded by the notifications test', now() - interval '2 minutes', now())
     RETURNING id`,
    [serverId, code, title],
  );
  return row!.id;
}

describe("notifications API", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("filters each row by its own scope and dismisses only what the caller can see", async () => {
    const admin = await loginAsBootstrap();
    const [server] = await dbQuery<{ id: string }>(
      "SELECT id FROM pdns_servers WHERE slug = 'standalone'",
    );
    const tag = Date.now().toString(36);
    const mine = `granted-${tag}.example.com.`;
    const other = `other-${tag}.example.com.`;
    const backendId = await seed(server!.id, `test.notify.${tag}`, "Backend test advisory");
    const mineId = await seed(server!.id, `monitor.${mine}.soa.mname`, `${mine} finding`);
    const otherId = await seed(server!.id, `monitor.${other}.soa.mname`, `${other} finding`);

    const all = (await (
      await admin.call("/api/admin/notifications", { method: "GET" })
    ).json()) as ListBody;
    const ids = all.notifications.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining([backendId, mineId, otherId]));
    expect(all.notifications.find((n) => n.id === mineId)).toMatchObject({
      source: "zone",
      zone: mine,
    });

    const { client: scoped, user } = await createAndLogin(admin, {
      email: uniqueEmail("notify-scoped"),
      name: "Scoped notifications",
      password: "notify-scoped-test-pw-1234",
    });
    await admin.sendJson("POST", `/api/admin/users/${user.id}/zone-grants`, {
      serverId: server!.id,
      zoneName: mine,
      permissions: ["zone.read"],
    });
    const scopedList = (await (
      await scoped.call("/api/admin/notifications", { method: "GET" })
    ).json()) as ListBody;
    expect(scopedList.notifications.map((n) => n.id)).toEqual([mineId]);

    // Invisible ids are skipped, visible ones dismissed, and the response does not say which.
    const res = await scoped.call("/api/admin/notifications/dismiss", {
      method: "POST",
      json: { ids: [mineId, otherId, backendId] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dismissed: [mineId], skipped: 2 });
    expect(
      (
        await scoped.call(`/api/admin/backend-advisories/${otherId}/ack`, {
          method: "POST",
          json: {},
        })
      ).status,
    ).toBe(404);

    const after = (await (
      await admin.call("/api/admin/notifications?status=all", { method: "GET" })
    ).json()) as ListBody;
    expect(after.notifications.find((n) => n.id === mineId)?.acknowledged).toBe(true);
    expect(after.notifications.find((n) => n.id === otherId)?.acknowledged).toBe(false);

    const audit = await dbQuery<{ resource_id: string }>(
      `SELECT resource_id FROM audit_log WHERE action = 'backend_advisory.acknowledge' AND resource_id = ANY($1)`,
      [[mineId, otherId, backendId]],
    );
    expect(audit.map((a) => a.resource_id)).toEqual([mineId]);
  }, 60_000);

  it("validates input", async () => {
    const admin = await loginAsBootstrap();
    expect(
      (await admin.call("/api/admin/notifications/dismiss", { method: "POST", json: { ids: [] } }))
        .status,
    ).toBe(400);
    expect(
      (await admin.call("/api/admin/notifications?status=maybe", { method: "GET" })).status,
    ).toBe(400);
  });
});
