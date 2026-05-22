/**
 * tests/integration/auth/api-tokens.test.ts
 *
 * Personal access tokens — self-service issuance, listing, redemption
 * via the one-time reveal endpoint, and Bearer-auth-driven API access.
 * Verifies the plaintext is never returned in the JSON body and that
 * revocation invalidates subsequent token use.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap, loginAs, createUser, uniqueEmail, SYSTEM_ROLES } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface CreateTokenResponse {
  ok: boolean;
  token: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    expiresAt: string | null;
    createdAt: string;
  };
  revealToken: string;
  expiresInSec: number;
}

describe("/api/profile/tokens", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST issues a token; response carries reveal token, NOT the plaintext", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/profile/tokens", {
      method: "POST",
      json: { name: "issue-test", scopes: [] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateTokenResponse & { plaintext?: unknown };
    expect(body.ok).toBe(true);
    expect(body.token.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token.prefix).toBeTypeOf("string");
    expect(body.revealToken).toBeTypeOf("string");
    expect(body.expiresInSec).toBeGreaterThan(0);
    // No raw secret in the JSON body.
    expect(body.plaintext).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/pda_pat_/);
  });

  it("POST /api/profile/tokens/[id]/reveal returns the plaintext exactly once", async () => {
    const admin = await loginAsBootstrap();
    const created = await admin.sendJson<CreateTokenResponse>("POST", "/api/profile/tokens", {
      name: "reveal-once",
      scopes: [],
    });

    const firstRes = await admin.call(`/api/profile/tokens/${created.token.id}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get("content-type")).toMatch(/text\/plain/);
    const plaintext = await firstRes.text();
    expect(plaintext).toMatch(/^pda_pat_/);

    // Second redemption is rejected — single-use semantics.
    const secondRes = await admin.call(`/api/profile/tokens/${created.token.id}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    expect(secondRes.status).toBe(404);
  });

  it("GET lists the caller's tokens (no plaintext, no token hash)", async () => {
    const admin = await loginAsBootstrap();
    await admin.sendJson("POST", "/api/profile/tokens", { name: "list-1", scopes: [] });
    await admin.sendJson("POST", "/api/profile/tokens", { name: "list-2", scopes: [] });

    const { tokens } = await admin.getJson<{
      tokens: Array<{
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>("/api/profile/tokens");
    const names = tokens.map((t) => t.name);
    expect(names).toContain("list-1");
    expect(names).toContain("list-2");
    expect(JSON.stringify(tokens)).not.toMatch(/pda_pat_[A-Za-z0-9]/);
  });

  it("Bearer-auth: token inheriting bootstrap admin's scopes can hit /api/admin/users (200)", async () => {
    const admin = await loginAsBootstrap();
    const created = await admin.sendJson<CreateTokenResponse>("POST", "/api/profile/tokens", {
      name: "bearer-test",
      scopes: [],
    });

    const revealRes = await admin.call(`/api/profile/tokens/${created.token.id}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    const plaintext = await revealRes.text();

    const apiRes = await fetch("http://localhost:3000/api/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(apiRes.status).toBe(200);
  });

  it("Bearer-auth: token clamped to non-user scopes is forbidden on /api/admin/users (403)", async () => {
    const admin = await loginAsBootstrap();
    const created = await admin.sendJson<CreateTokenResponse>("POST", "/api/profile/tokens", {
      name: "narrow-scope",
      scopes: ["zone.read"],
    });

    const revealRes = await admin.call(`/api/profile/tokens/${created.token.id}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    const plaintext = await revealRes.text();

    const apiRes = await fetch("http://localhost:3000/api/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(apiRes.status).toBe(403);
  });

  it("Bearer-auth: revoking the token causes subsequent use to return 401", async () => {
    const admin = await loginAsBootstrap();
    const created = await admin.sendJson<CreateTokenResponse>("POST", "/api/profile/tokens", {
      name: "revoke-test",
      scopes: [],
    });
    const revealRes = await admin.call(`/api/profile/tokens/${created.token.id}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    const plaintext = await revealRes.text();

    // Pre-revoke: works.
    const before = await fetch("http://localhost:3000/api/admin/users", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(before.status).toBe(200);

    await admin.sendJson("DELETE", `/api/profile/tokens/${created.token.id}`);

    const after = await fetch("http://localhost:3000/api/admin/users", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(after.status).toBe(401);
  });

  it("operator-scoped token holder cannot mint a token with scopes they don't hold (403)", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-scope"),
      name: "OpScope",
      password: "abcdef-123456-osc",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);

    const res = await opClient.call("/api/profile/tokens", {
      method: "POST",
      json: { name: "over-scope", scopes: ["user.delete"] },
    });
    expect(res.status).toBe(403);
  });

  it("audit_log records auth.token.issued and auth.token.revoked", async () => {
    const admin = await loginAsBootstrap();
    const created = await admin.sendJson<CreateTokenResponse>("POST", "/api/profile/tokens", {
      name: "audit-test",
      scopes: [],
    });
    await admin.sendJson("DELETE", `/api/profile/tokens/${created.token.id}`);

    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY ts",
      [created.token.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.token.issued");
    expect(actions).toContain("auth.token.revoked");
  });
});
