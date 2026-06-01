/**
 * tests/integration/auth/password-change.test.ts
 *
 * POST /api/auth/change-password - self-service password change for
 * the authenticated user. To avoid mutating the bootstrap admin's
 * password (which subsequent tests need), we operate on a fresh user
 * we create per test.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

describe("POST /api/auth/change-password", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("happy path: changes password, logs in with new password, old password is rejected", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("pwchange");
    const oldPassword = "old-password-12345";
    const newPassword = "new-password-67890";
    await createUser(admin, { email, name: "PwChange", password: oldPassword });

    const userClient = await loginAs(email, oldPassword);
    const res = await userClient.call("/api/auth/change-password", {
      method: "POST",
      json: {
        currentPassword: oldPassword,
        newPassword,
        confirmPassword: newPassword,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Old password no longer works.
    const oldLogin = await fetch(`${userClient.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    expect(oldLogin.status).toBe(401);

    // New password does.
    const newLogin = await loginAs(email, newPassword);
    expect(newLogin.hasCookie("pda_csrf")).toBe(true);
  });

  it("rejects wrong currentPassword with 400 (ValidationError)", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("pwwrong");
    const password = "right-password-12345";
    await createUser(admin, { email, name: "PwWrong", password });

    const userClient = await loginAs(email, password);
    const res = await userClient.call("/api/auth/change-password", {
      method: "POST",
      json: {
        currentPassword: "wrong-password-12345",
        newPassword: "another-password-12345",
        confirmPassword: "another-password-12345",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/current password is incorrect/i);
  });

  it("rejects newPassword shorter than 12 characters with 400", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("pwshort");
    const password = "right-password-12345";
    await createUser(admin, { email, name: "PwShort", password });

    const userClient = await loginAs(email, password);
    const res = await userClient.call("/api/auth/change-password", {
      method: "POST",
      json: {
        currentPassword: password,
        newPassword: "tooShort",
        confirmPassword: "tooShort",
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects when newPassword !== confirmPassword with 400", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("pwmismatch");
    const password = "right-password-12345";
    await createUser(admin, { email, name: "PwMismatch", password });

    const userClient = await loginAs(email, password);
    const res = await userClient.call("/api/auth/change-password", {
      method: "POST",
      json: {
        currentPassword: password,
        newPassword: "new-password-12345",
        confirmPassword: "different-12345-pw",
      },
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication (401 with no session)", async () => {
    const res = await fetch("http://localhost:3000/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "whatever-pw-12345",
        newPassword: "another-pw-12345",
        confirmPassword: "another-pw-12345",
      }),
    });
    expect(res.status).toBe(401);
  });
});
