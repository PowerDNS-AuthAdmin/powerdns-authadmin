/**
 * tests/integration/profile/email-change.test.ts
 *
 * Email change request + confirm flow. The mint route stashes the
 * confirm URL in the audit row's `after.url` (transactional email is
 * not wired yet) - the test extracts the token from there. Wrong
 * password and already-taken email failure modes are also covered.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

async function readLatestChangeUrl(userId: string): Promise<string> {
  const rows = await dbQuery<{ url: string }>(
    "SELECT (after->>'url') AS url FROM audit_log WHERE action = $1 AND resource_id = $2 ORDER BY ts DESC LIMIT 1",
    ["auth.email.change.requested", userId],
  );
  if (!rows[0]?.url) {
    throw new Error("No email-change audit row with a URL was found");
  }
  return rows[0].url;
}

function extractToken(url: string): string {
  const parsed = new URL(url);
  const t = parsed.searchParams.get("token");
  if (!t) throw new Error(`No token query parameter in ${url}`);
  return t;
}

describe("/api/profile/email/change + confirm", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("happy path: requests a change, confirms with the token, email is swapped + sessions revoked", async () => {
    const admin = await loginAsBootstrap();
    const oldEmail = uniqueEmail("change-old");
    const newEmail = uniqueEmail("change-new");
    const password = "abcdef-123456-cha";
    const created = await createUser(admin, { email: oldEmail, name: "Changer", password });
    const userClient = await loginAs(oldEmail, password);

    const reqRes = await userClient.call("/api/profile/email/change", {
      method: "POST",
      json: { newEmail, currentPassword: password },
    });
    expect(reqRes.status).toBe(200);

    const url = await readLatestChangeUrl(created.id);
    const token = extractToken(url);

    const confirmRes = await userClient.call("/api/profile/email/change/confirm", {
      method: "POST",
      json: { token },
    });
    expect(confirmRes.status).toBe(200);
    const body = (await confirmRes.json()) as { ok: boolean; email: string };
    expect(body.ok).toBe(true);
    expect(body.email).toBe(newEmail.toLowerCase());

    const rows = await dbQuery<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      created.id,
    ]);
    expect(rows[0]!.email).toBe(newEmail.toLowerCase());

    // Confirm revokes every session for the user (including the one
    // that just made the request).
    const sessionRows = await dbQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1",
      [created.id],
    );
    expect(Number(sessionRows[0]!.count)).toBe(0);

    // Login under the new email succeeds, under the old one fails.
    const newLogin = await loginAs(newEmail, password);
    expect(newLogin.hasCookie("pda_csrf")).toBe(true);
    const oldLogin = await fetch(`${admin.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: oldEmail, password }),
    });
    expect(oldLogin.status).toBe(401);
  });

  it("rejects request with wrong current password (400, ValidationError)", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("change-wrongpw");
    const password = "abcdef-123456-wpw";
    await createUser(admin, { email, name: "WrongPw", password });
    const userClient = await loginAs(email, password);

    const res = await userClient.call("/api/profile/email/change", {
      method: "POST",
      json: { newEmail: uniqueEmail("change-target"), currentPassword: "not-the-password-12345" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/current password/i);
  });

  it("rejects request when target email is already taken (400, ValidationError)", async () => {
    const admin = await loginAsBootstrap();
    const taken = uniqueEmail("already-taken");
    await createUser(admin, { email: taken, name: "Squatter", password: "abcdef-123456-sq" });

    const own = uniqueEmail("change-collide");
    const password = "abcdef-123456-col";
    await createUser(admin, { email: own, name: "Collider", password });
    const userClient = await loginAs(own, password);

    const res = await userClient.call("/api/profile/email/change", {
      method: "POST",
      json: { newEmail: taken, currentPassword: password },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already in use/i);
  });

  it("rejects confirm with an invalid token (400)", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("change-badtoken");
    const password = "abcdef-123456-bdt";
    await createUser(admin, { email, name: "BadToken", password });
    const userClient = await loginAs(email, password);

    const res = await userClient.call("/api/profile/email/change/confirm", {
      method: "POST",
      json: { token: "pde_obviously-not-a-real-token-payload" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects confirm when the token's userId does not match the caller (403)", async () => {
    const admin = await loginAsBootstrap();

    const aliceEmail = uniqueEmail("alice");
    const alicePw = "abcdef-123456-ali";
    const alice = await createUser(admin, { email: aliceEmail, name: "Alice", password: alicePw });
    const aliceClient = await loginAs(aliceEmail, alicePw);

    const newEmail = uniqueEmail("alice-new");
    await aliceClient.call("/api/profile/email/change", {
      method: "POST",
      json: { newEmail, currentPassword: alicePw },
    });
    const url = await readLatestChangeUrl(alice.id);
    const aliceToken = extractToken(url);

    const bobEmail = uniqueEmail("bob");
    const bobPw = "abcdef-123456-bob";
    await createUser(admin, { email: bobEmail, name: "Bob", password: bobPw });
    const bobClient = await loginAs(bobEmail, bobPw);

    const res = await bobClient.call("/api/profile/email/change/confirm", {
      method: "POST",
      json: { token: aliceToken },
    });
    expect(res.status).toBe(403);
  });
});
