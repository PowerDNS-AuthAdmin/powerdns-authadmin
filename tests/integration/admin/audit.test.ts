/**
 * tests/integration/admin/audit.test.ts
 *
 * /api/admin/audit/export — CSV export of audit rows. Tests verify a
 * just-generated user.create event appears in the export, that the
 * action= filter narrows results, and that a non-auditor caller is 403.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

describe("/api/admin/audit/export", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("exports a CSV that contains a freshly created user", async () => {
    const admin = await loginAsBootstrap();
    const u = await createUser(admin, {
      email: uniqueEmail("audit-export"),
      name: "Audit Export",
      password: "audit-export-pw-12345",
    });

    const res = await admin.call("/api/admin/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/csv/i);
    const csv = await res.text();
    expect(csv).toContain("user.create");
    expect(csv).toContain(u.id);
  });

  it("filters by action= and only returns matching rows", async () => {
    const admin = await loginAsBootstrap();
    await createUser(admin, {
      email: uniqueEmail("audit-filter"),
      name: "Audit Filter",
      password: "audit-filter-pw-12345",
    });
    const res = await admin.call("/api/admin/audit/export?action=user.create");
    expect(res.status).toBe(200);
    const csv = await res.text();
    const lines = csv.split("\n").filter((l) => l.trim() !== "");
    // First line is the header row; remaining lines should all be user.create.
    for (const line of lines.slice(1)) {
      expect(line).toContain("user.create");
    }
  });

  it("rejects invalid filter values with 400", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/audit/export?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("non-admin (operator) cannot export — 403", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-audit"),
      name: "Op Audit",
      password: "operator-audit-pass-12345",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/audit/export");
    expect(res.status).toBe(403);
  });
});
