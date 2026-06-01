/**
 * tests/integration/admin/users.test.ts
 *
 * /api/admin/users - list / create / update / disable / role-assign.
 * Drives the routes via HTTP as the bootstrap admin and verifies the
 * effects via both the API surface and direct DB reads.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createUser,
  loginAs,
  loginAsBootstrap,
  resolveRoleId,
  SYSTEM_ROLES,
  uniqueEmail,
} from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

describe("/api/admin/users", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("lists users - bootstrap admin is present after a fresh reset", async () => {
    const admin = await loginAsBootstrap();
    const { users } = await admin.getJson<{ users: Array<{ email: string }> }>("/api/admin/users");
    const emails = users.map((u) => u.email);
    expect(emails).toContain(process.env["TEST_BOOTSTRAP_EMAIL"] ?? "admin@test.local");
  });

  it("creates a user with a global operator role", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("operator");
    const user = await createUser(admin, {
      email,
      name: "Test Operator",
      password: "operator-test-password-123",
      roleSlug: SYSTEM_ROLES.operator,
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    const assignments = await dbQuery<{ scope_type: string; role_id: string }>(
      "SELECT scope_type, role_id FROM role_assignments WHERE user_id = $1",
      [user.id],
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.scope_type).toBe("global");
    expect(assignments[0]!.role_id).toBe(await resolveRoleId(admin, SYSTEM_ROLES.operator));
  });

  it("the created user can log in with the provided password", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("login-test");
    const password = "fresh-user-pw-1234567";
    await createUser(admin, { email, name: "Logs In", password });

    const userClient = await loginAs(email, password);
    expect(userClient.hasCookie("pda_csrf")).toBe(true);
  });

  it("rejects duplicate email with 409 conflict", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("dup");
    await createUser(admin, { email, name: "First", password: "abcdef-123456-ghij" });
    const res = await admin.call("/api/admin/users", {
      method: "POST",
      json: { email, name: "Second", password: "abcdef-123456-ghij" },
    });
    expect(res.status).toBe(409);
  });

  it("rejects short password (< 12 chars) with 400", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/users", {
      method: "POST",
      json: { email: uniqueEmail("shortpw"), name: "ShortPW", password: "tooShort" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects requests without CSRF header with 403", async () => {
    const admin = await loginAsBootstrap();
    // Manually strip the csrf header by forging the request:
    const res = await fetch(`${admin.baseUrl}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ["pda_session", "pda_csrf"]
          .map((k) => `${k}=${admin.getCookie(k) ?? ""}`)
          .join("; "),
        // intentionally no x-csrf-token
      },
      body: JSON.stringify({
        email: uniqueEmail("nocsrf"),
        name: "NoCsrf",
        password: "abcdef-123456",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /api/admin/users/[id] updates name", async () => {
    const admin = await loginAsBootstrap();
    const created = await createUser(admin, {
      email: uniqueEmail("patch"),
      name: "Original",
      password: "abcdef-123456-jklmn",
    });
    await admin.sendJson("PATCH", `/api/admin/users/${created.id}`, { name: "Renamed" });
    const { users } = await admin.getJson<{ users: Array<{ id: string; name: string }> }>(
      "/api/admin/users",
    );
    expect(users.find((u) => u.id === created.id)?.name).toBe("Renamed");
  });

  it("PATCH /api/admin/users/[id] can disable a user; disabled user cannot log in", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("disable");
    const password = "abcdef-123456-pqrst";
    const created = await createUser(admin, { email, name: "ToDisable", password });

    // Confirm pre-disable login works
    await loginAs(email, password);

    await admin.sendJson("PATCH", `/api/admin/users/${created.id}`, { disabled: true });

    const reLogin = await fetch(`${admin.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(reLogin.status).toBe(401);
  });

  it("non-admin caller (operator) cannot create users - 403", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-perm"),
      name: "Op",
      password: "abcdef-123456-zzz",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/users", {
      method: "POST",
      json: { email: uniqueEmail("forbidden"), name: "Nope", password: "abcdef-123456-yyy" },
    });
    expect(res.status).toBe(403);
  });

  it("audit log records user.created and role.assignment.created", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("audit");
    const created = await createUser(admin, {
      email,
      name: "Audited",
      password: "abcdef-123456-wxyz",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const rows = await dbQuery<{ action: string; resource_id: string }>(
      "SELECT action, resource_id FROM audit_log WHERE resource_id = $1 ORDER BY ts",
      [created.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("user.create");
    expect(actions).toContain("role.assignment.created");
  });
});
