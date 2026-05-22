/**
 * tests/integration/profile/name.test.ts
 *
 * PATCH /api/profile/name — self-service display name edit. Empty
 * string is treated as a clear (DB stores NULL). Verifies the change
 * is visible via the admin list and reflected in the users table.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

describe("PATCH /api/profile/name", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("updates the caller's display name", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("rename");
    const password = "abcdef-123456-rn";
    const created = await createUser(admin, { email, name: "Before", password });
    const client = await loginAs(email, password);

    const res = await client.call("/api/profile/name", {
      method: "PATCH",
      json: { name: "After" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string | null };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("After");

    const { users } = await admin.getJson<{ users: Array<{ id: string; name: string | null }> }>(
      "/api/admin/users",
    );
    expect(users.find((u) => u.id === created.id)?.name).toBe("After");
  });

  it("empty string clears the name to NULL in the DB", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("clear-name");
    const password = "abcdef-123456-cn";
    const created = await createUser(admin, { email, name: "Initial", password });
    const client = await loginAs(email, password);

    const res = await client.call("/api/profile/name", {
      method: "PATCH",
      json: { name: "" },
    });
    expect(res.status).toBe(200);

    const rows = await dbQuery<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [
      created.id,
    ]);
    expect(rows[0]!.name).toBeNull();
  });

  it("trims whitespace before persisting", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("trim-name");
    const password = "abcdef-123456-tn";
    const created = await createUser(admin, { email, name: "X", password });
    const client = await loginAs(email, password);

    const res = await client.call("/api/profile/name", {
      method: "PATCH",
      json: { name: "  Padded  " },
    });
    expect(res.status).toBe(200);

    const rows = await dbQuery<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [
      created.id,
    ]);
    expect(rows[0]!.name).toBe("Padded");
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await fetch("http://localhost:3000/api/profile/name", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects names longer than 120 characters with 400", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("toolong");
    const password = "abcdef-123456-tl";
    await createUser(admin, { email, name: "Original", password });
    const client = await loginAs(email, password);

    const res = await client.call("/api/profile/name", {
      method: "PATCH",
      json: { name: "x".repeat(121) },
    });
    expect(res.status).toBe(400);
  });
});
