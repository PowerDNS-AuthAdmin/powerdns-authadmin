/**
 * tests/integration/notifications/notifications-api.test.ts
 *
 * The notification list and dismiss routes apply visibility per row: backend
 * health needs server.read, a zone-monitoring finding needs zone.read on its
 * zone. A user granted one zone sees only that zone's findings and cannot
 * dismiss anything else.
 *
 * The rows are seeded on a disabled copy of the standalone backend. Zone
 * monitoring is on in the test stack and correctly prunes findings for zones
 * that do not exist on the backends it probes; it never probes a disabled one,
 * so the seeded rows cannot vanish mid-test.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery, withDb } from "../helpers/db";
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

/**
 * A copy of the standalone backend under a new id and slug. Copied column for
 * column so the test does not depend on the table's full shape.
 */
async function cloneStandaloneBackend(slug: string): Promise<string> {
  return withDb(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(
        "CREATE TEMP TABLE notify_clone ON COMMIT DROP AS SELECT * FROM pdns_servers WHERE slug = 'standalone'",
      );
      const { rows } = await c.query<{ id: string }>(
        "UPDATE notify_clone SET id = gen_random_uuid(), slug = $1, name = $1, is_default = false RETURNING id",
        [slug],
      );
      await c.query("INSERT INTO pdns_servers SELECT * FROM notify_clone");
      await c.query("COMMIT");
      return rows[0]!.id;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

describe("notifications API", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("filters each row by its own scope and dismisses only what the caller can see", async () => {
    const admin = await loginAsBootstrap();
    const tag = Date.now().toString(36);
    const serverId = await cloneStandaloneBackend(`notify-${tag}`);
    try {
      const mine = `granted-${tag}.example.com.`;
      const other = `other-${tag}.example.com.`;

      const { client: scoped, user } = await createAndLogin(admin, {
        email: uniqueEmail("notify-scoped"),
        name: "Scoped notifications",
        password: "notify-scoped-test-pw-1234",
      });
      await admin.sendJson("POST", `/api/admin/users/${user.id}/zone-grants`, {
        serverId,
        zoneName: mine,
        permissions: ["zone.read"],
      });
      // Grants need an active backend; disable the copy only now, before seeding.
      await dbQuery("UPDATE pdns_servers SET disabled_at = now() WHERE id = $1", [serverId]);

      const backendId = await seed(serverId, `test.notify.${tag}`, "Backend test advisory");
      const mineId = await seed(serverId, `monitor.${mine}.soa.mname`, `${mine} finding`);
      const otherId = await seed(serverId, `monitor.${other}.soa.mname`, `${other} finding`);

      const all = (await (
        await admin.call("/api/admin/notifications", { method: "GET" })
      ).json()) as ListBody;
      expect(all.notifications.map((n) => n.id)).toEqual(
        expect.arrayContaining([backendId, mineId, otherId]),
      );
      expect(all.notifications.find((n) => n.id === mineId)).toMatchObject({
        source: "zone",
        zone: mine,
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
    } finally {
      // Advisories and grants on the copy go with it (ON DELETE CASCADE).
      await dbQuery("DELETE FROM pdns_servers WHERE id = $1", [serverId]);
    }
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
