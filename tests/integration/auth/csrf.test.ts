/**
 * tests/integration/auth/csrf.test.ts
 *
 * CSRF enforcement on representative mutating routes. Each test forges
 * a raw fetch without `x-csrf-token` and asserts 403, then re-issues
 * the same call via the TestHttp helper (which auto-injects the
 * header) and asserts success. GET is verified unconditionally exempt.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

function forgeCookies(cookies: Array<{ name: string; value: string | undefined }>): string {
  return cookies
    .filter((c) => c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

describe("CSRF enforcement on mutating routes", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST /api/admin/users without x-csrf-token → 403, with header → 201", async () => {
    const admin = await loginAsBootstrap();

    const noHeader = await fetch(`${admin.baseUrl}/api/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: forgeCookies([
          { name: "pda_session", value: admin.getCookie("pda_session") },
          { name: "pda_csrf", value: admin.getCookie("pda_csrf") },
        ]),
      },
      body: JSON.stringify({
        email: uniqueEmail("csrf-no"),
        name: "NoCsrf",
        password: "abcdef-123456-csrf",
      }),
    });
    expect(noHeader.status).toBe(403);

    const withHeader = await admin.call("/api/admin/users", {
      method: "POST",
      json: {
        email: uniqueEmail("csrf-yes"),
        name: "WithCsrf",
        password: "abcdef-123456-csrf",
      },
    });
    expect(withHeader.status).toBe(201);
  });

  it("PATCH /api/admin/users/[id] without x-csrf-token → 403, with header → 200", async () => {
    const admin = await loginAsBootstrap();
    const created = await createUser(admin, {
      email: uniqueEmail("csrf-patch"),
      name: "Original",
      password: "abcdef-123456-csrf",
    });

    const noHeader = await fetch(`${admin.baseUrl}/api/admin/users/${created.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: forgeCookies([
          { name: "pda_session", value: admin.getCookie("pda_session") },
          { name: "pda_csrf", value: admin.getCookie("pda_csrf") },
        ]),
      },
      body: JSON.stringify({ name: "NoCsrfRename" }),
    });
    expect(noHeader.status).toBe(403);

    const withHeader = await admin.call(`/api/admin/users/${created.id}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(withHeader.status).toBe(200);
  });

  it("POST /api/admin/teams without x-csrf-token → 403, with header → 201", async () => {
    const admin = await loginAsBootstrap();
    const stamp = Date.now().toString(36);

    const noHeader = await fetch(`${admin.baseUrl}/api/admin/teams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: forgeCookies([
          { name: "pda_session", value: admin.getCookie("pda_session") },
          { name: "pda_csrf", value: admin.getCookie("pda_csrf") },
        ]),
      },
      body: JSON.stringify({ slug: `csrf-no-${stamp}`, name: "NoCsrf" }),
    });
    expect(noHeader.status).toBe(403);

    const withHeader = await admin.call("/api/admin/teams", {
      method: "POST",
      json: { slug: `csrf-yes-${stamp}`, name: "WithCsrf" },
    });
    expect(withHeader.status).toBe(201);
  });

  it("DELETE /api/auth/sessions/[id] without x-csrf-token → 403, with header → 200", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("csrf-sess");
    const password = "abcdef-123456-csrf";
    const created = await createUser(admin, { email, name: "SessionOwner", password });

    // Two separate logins create two distinct session rows.
    const clientA = await loginAs(email, password);
    const clientB = await loginAs(email, password);

    const rows = await dbQuery<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at",
      [created.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const firstSessionId = rows[0]!.id;
    const secondSessionId = rows[1]!.id;

    const noHeader = await fetch(`${clientA.baseUrl}/api/auth/sessions/${firstSessionId}`, {
      method: "DELETE",
      headers: {
        cookie: forgeCookies([
          { name: "pda_session", value: clientA.getCookie("pda_session") },
          { name: "pda_csrf", value: clientA.getCookie("pda_csrf") },
        ]),
      },
    });
    expect(noHeader.status).toBe(403);

    const withHeader = await clientB.call(`/api/auth/sessions/${secondSessionId}`, {
      method: "DELETE",
    });
    expect(withHeader.status).toBe(200);
  });

  it("GET /api/admin/users is exempt from CSRF (succeeds without header)", async () => {
    const admin = await loginAsBootstrap();
    const noHeader = await fetch(`${admin.baseUrl}/api/admin/users`, {
      method: "GET",
      headers: {
        cookie: forgeCookies([
          { name: "pda_session", value: admin.getCookie("pda_session") },
          { name: "pda_csrf", value: admin.getCookie("pda_csrf") },
        ]),
      },
    });
    expect(noHeader.status).toBe(200);
  });
});
