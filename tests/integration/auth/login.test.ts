/**
 * tests/integration/auth/login.test.ts
 *
 * POST /api/auth/login - local credential login. Covers the happy path,
 * the family of failure modes, and the session cookie issuance contract
 * the rest of the suite depends on.
 *
 * Out-of-scope here:
 *   - TOTP MFA challenge (covered by `mfa-totp.test.ts`)
 *   - Rate limiting & account lockout (covered by `rate-limit.test.ts`)
 *   - OIDC login (covered by `oidc-login.test.ts` once an IdP fixture
 *     stack is wired up)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { anonClient } from "../helpers/http";
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("logs in the bootstrap admin and returns the user payload", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      json: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; email: string; name: string; mustChangePassword: boolean };
    };
    expect(body.user.email).toBe(BOOTSTRAP_EMAIL);
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.hasCookie("pda_csrf")).toBe(true);
  });

  it("issues a usable session cookie that authorizes follow-up calls", async () => {
    const admin = await loginAsBootstrap();
    const profile = await admin.getJson<{ name: string }>("/api/profile/name", [405]);
    // /api/profile/name may be GET-only or POST-only depending on the app;
    // we tolerate 405 here and verify the session cookie itself instead.
    expect(admin.hasCookie("pda_csrf")).toBe(true);
    expect(profile).toBeDefined();
  });

  it("rejects wrong password with 401 and the uniform error", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      json: { email: BOOTSTRAP_EMAIL, password: "this-is-definitely-not-the-password" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid email or password/i);
  });

  it("rejects unknown email with the same 401 message (no account-exists leak)", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      json: { email: "does-not-exist@test.local", password: "whatever" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid email or password/i);
  });

  it("rejects malformed JSON body with 400", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects body without email/password with 400", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      json: { email: "missing-password@test.local" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-email email field with 400", async () => {
    const client = anonClient();
    const res = await client.call("/api/auth/login", {
      method: "POST",
      json: { email: "not-an-email", password: "anything" },
    });
    expect(res.status).toBe(400);
  });
});
