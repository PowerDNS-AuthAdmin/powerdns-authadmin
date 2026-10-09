/**
 * tests/integration/admin/backup.test.ts
 *
 * Round-trip of the app-DB backup: export with audit rows present (which
 * used to 500 on Postgres - `bigserial` ids are BigInt), wipe the user data,
 * restore the export, and prove the rows came back with their timestamps
 * intact and the restore reported real insert counts (it used to report
 * success while inserting nothing).
 *
 * The reset helper truncates `audit_log` with RESTART IDENTITY, so restored
 * audit rows reuse ids from 1 - a follow-up audited action proves the
 * sequence was moved past them.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAsBootstrap, uniqueEmail, SYSTEM_ROLES } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface BackupBundle {
  meta: { schema_version: number; exported_at: string };
  tables: Record<string, Array<Record<string, unknown>>>;
}

interface RestoreResponse {
  ok: boolean;
  counts: Record<string, { attempted: number; inserted: number; skipped: number; failed: number }>;
}

describe("backup export + restore", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("exports with audit rows present and restores users, grants and audit rows intact", async () => {
    const admin = await loginAsBootstrap();
    const created = await createUser(admin, {
      email: uniqueEmail("backup"),
      name: "Backup Subject",
      password: "backup-subject-pw-12345",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const { team } = await admin.sendJson<{ team: { id: string } }>("POST", "/api/admin/teams", {
      name: "Backup Team",
      slug: `backup-team-${Date.now()}`,
    });
    const servers = await dbQuery<{ id: string }>("SELECT id FROM pdns_servers LIMIT 1");
    const serverId = servers[0]!.id;
    await admin.sendJson("POST", `/api/admin/users/${created.id}/zone-grants`, {
      serverId,
      zoneName: "backup-grant.example.com.",
      permissions: ["zone.read"],
    });

    // --- export ---
    const exportRes = await admin.call("/api/admin/backup/export");
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const bundle = (await exportRes.json()) as BackupBundle;
    expect(bundle.meta.schema_version).toBe(1);

    const exportedUser = bundle.tables["users"]!.find((u) => u["id"] === created.id);
    expect(exportedUser).toBeDefined();
    expect(typeof exportedUser!["createdAt"]).toBe("string");
    expect(bundle.tables["audit_log"]!.length).toBeGreaterThan(0);
    // Postgres bigserial ids ride as decimal strings.
    expect(bundle.tables["audit_log"]!.every((r) => typeof r["id"] === "string")).toBe(true);
    expect(bundle.tables["zone_grants"]!.some((g) => g["userId"] === created.id)).toBe(true);
    expect(bundle.tables["teams"]!.some((t) => t["id"] === team.id)).toBe(true);

    const originalCreatedAt = exportedUser!["createdAt"] as string;
    const auditRowsExported = bundle.tables["audit_log"]!.length;

    // --- wipe (keeps roles, settings, backends and the bootstrap admin) ---
    await resetState({ skipPdns: true });
    expect(await dbQuery("SELECT id FROM users WHERE id = $1", [created.id])).toHaveLength(0);
    expect(await dbQuery("SELECT id FROM audit_log")).toHaveLength(0);

    // --- restore ---
    const admin2 = await loginAsBootstrap();
    const restoreRes = await admin2.call("/api/admin/backup/restore", {
      method: "POST",
      json: bundle,
    });
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as RestoreResponse;
    expect(restored.ok).toBe(true);

    // Real insert accounting: the created user is inserted, the bootstrap
    // admin (still present) is skipped, nothing fails.
    expect(restored.counts["users"]!.failed).toBe(0);
    expect(restored.counts["users"]!.inserted).toBe(1);
    expect(restored.counts["users"]!.skipped).toBe(restored.counts["users"]!.attempted - 1);
    expect(restored.counts["teams"]!.inserted).toBe(1);
    expect(restored.counts["zone_grants"]!.inserted).toBeGreaterThanOrEqual(1);
    expect(restored.counts["zone_grants"]!.failed).toBe(0);
    // The audit table was truncated, so every exported row is a real insert.
    expect(restored.counts["audit_log"]!.inserted).toBe(auditRowsExported);
    expect(restored.counts["audit_log"]!.failed).toBe(0);

    const rows = await dbQuery<{ created_at: Date; email: string }>(
      "SELECT created_at, email FROM users WHERE id = $1",
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at.toISOString()).toBe(originalCreatedAt);

    const grants = await dbQuery<{ zone_name: string }>(
      "SELECT zone_name FROM zone_grants WHERE user_id = $1",
      [created.id],
    );
    expect(grants.map((g) => g.zone_name)).toContain("backup-grant.example.com.");

    const audit = await dbQuery<{ n: string; latest: Date }>(
      "SELECT COUNT(*)::text AS n, MAX(ts) AS latest FROM audit_log",
    );
    // Restored rows plus the login and the `system.backup.restored` row itself.
    expect(Number(audit[0]!.n)).toBeGreaterThan(auditRowsExported);
    expect(audit[0]!.latest).toBeInstanceOf(Date);

    // The sequence was moved past the restored ids: a fresh audited action
    // must not collide with a restored row.
    const another = await createUser(admin2, {
      email: uniqueEmail("after-restore"),
      name: "After Restore",
      password: "after-restore-pw-12345",
    });
    expect(another.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a bundle without the expected envelope", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/backup/restore", {
      method: "POST",
      json: { tables: {} },
    });
    expect(res.status).toBe(400);
  });
});
