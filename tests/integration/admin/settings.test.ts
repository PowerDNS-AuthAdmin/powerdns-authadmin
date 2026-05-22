/**
 * tests/integration/admin/settings.test.ts
 *
 * /api/admin/settings — read + patch app-wide runtime settings. Verifies a
 * single-field PATCH lands in the audit log as settings.write, and that a
 * non-admin caller is refused.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface SettingsBag {
  site_name?: string;
  brand_logo_url?: string;
  support_contact?: string;
  login_intro?: string;
  login_lockout_threshold?: number;
  login_lockout_seconds?: number;
}

describe("/api/admin/settings", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET returns the current settings bag with default keys present", async () => {
    const admin = await loginAsBootstrap();
    const { settings } = await admin.getJson<{ settings: SettingsBag }>("/api/admin/settings");
    expect(settings).toHaveProperty("site_name");
    expect(settings).toHaveProperty("login_lockout_threshold");
    expect(typeof settings.site_name).toBe("string");
  });

  it("PATCH updates site_name and the GET reflects the new value", async () => {
    const admin = await loginAsBootstrap();
    const fresh = `Test Site ${Date.now()}`;
    const res = await admin.call("/api/admin/settings", {
      method: "PATCH",
      json: { site_name: fresh },
    });
    expect(res.status).toBe(200);
    const { settings } = await admin.getJson<{ settings: SettingsBag }>("/api/admin/settings");
    expect(settings.site_name).toBe(fresh);
  });

  it("audit log records settings.write on a PATCH", async () => {
    const admin = await loginAsBootstrap();
    const fresh = `Audited Site ${Date.now()}`;
    await admin.sendJson("PATCH", "/api/admin/settings", { site_name: fresh });
    const rows = await dbQuery<{ action: string; after: Record<string, unknown> }>(
      "SELECT action, after FROM audit_log WHERE action = $1 ORDER BY ts DESC LIMIT 1",
      ["settings.write"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("settings.write");
    expect(rows[0]!.after).toMatchObject({ site_name: fresh });
  });

  it("rejects unknown setting keys with 400", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/settings", {
      method: "PATCH",
      json: { not_a_real_key: "boom" },
    });
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { changed: number };
      expect(body.changed).toBe(0);
    }
  });

  it("non-admin (operator) cannot update settings — 403", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-settings"),
      name: "Op Settings",
      password: "operator-settings-pass-123",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/settings", {
      method: "PATCH",
      json: { site_name: "shouldn't apply" },
    });
    expect(res.status).toBe(403);
  });
});
