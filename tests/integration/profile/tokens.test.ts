/**
 * tests/integration/profile/tokens.test.ts
 *
 * Thin companion to auth/api-tokens.test.ts. Verifies the GET listing
 * shape on the self-service endpoint and confirms that revoking a
 * different user's token requires going through the admin route
 * (the per-user admin DELETE) and that non-admins cannot use it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

interface CreateTokenResponse {
  ok: boolean;
  token: { id: string; name: string; prefix: string; scopes: string[]; createdAt: string };
  revealToken: string;
  expiresInSec: number;
}

describe("/api/profile/tokens — GET shape + admin-only revoke", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET /api/profile/tokens returns the expected fields", async () => {
    const admin = await loginAsBootstrap();
    await admin.sendJson("POST", "/api/profile/tokens", { name: "shape", scopes: [] });

    const body = await admin.getJson<{
      tokens: Array<{
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        expiresAt: string | null;
        lastUsedAt: string | null;
        revokedAt: string | null;
        createdAt: string;
      }>;
    }>("/api/profile/tokens");
    expect(Array.isArray(body.tokens)).toBe(true);
    const sample = body.tokens.find((t) => t.name === "shape");
    expect(sample).toBeDefined();
    expect(sample!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sample!.prefix).toBeTypeOf("string");
    expect(Array.isArray(sample!.scopes)).toBe(true);
    expect(sample!.expiresAt).toBeNull();
    expect(sample!.revokedAt).toBeNull();
    expect(sample!.createdAt).toMatch(/T/);
  });

  it("GET /api/profile/tokens lists only the caller's own tokens", async () => {
    const admin = await loginAsBootstrap();
    await admin.sendJson("POST", "/api/profile/tokens", { name: "admins-token", scopes: [] });

    const op = await createUser(admin, {
      email: uniqueEmail("op-list"),
      name: "OpList",
      password: "abcdef-123456-opl",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    await opClient.sendJson("POST", "/api/profile/tokens", { name: "op-token", scopes: [] });

    const opBody = await opClient.getJson<{ tokens: Array<{ name: string }> }>(
      "/api/profile/tokens",
    );
    const opNames = opBody.tokens.map((t) => t.name);
    expect(opNames).toContain("op-token");
    expect(opNames).not.toContain("admins-token");
  });

  it("admin can revoke another user's token via /api/admin/users/[id]/tokens/[tokenId]", async () => {
    const admin = await loginAsBootstrap();
    const target = await createUser(admin, {
      email: uniqueEmail("revoke-target"),
      name: "RevokeTarget",
      password: "abcdef-123456-rvt",
    });
    const targetClient = await loginAs(target.email, target.password);
    const created = await targetClient.sendJson<CreateTokenResponse>(
      "POST",
      "/api/profile/tokens",
      { name: "target-token", scopes: [] },
    );

    const res = await admin.call(`/api/admin/users/${target.id}/tokens/${created.token.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const { tokens } = await targetClient.getJson<{
      tokens: Array<{ id: string; revokedAt: string | null }>;
    }>("/api/profile/tokens");
    const sameRow = tokens.find((t) => t.id === created.token.id);
    expect(sameRow?.revokedAt).not.toBeNull();
  });

  it("non-admin (operator) cannot revoke another user's token via the admin route (403)", async () => {
    const admin = await loginAsBootstrap();
    const target = await createUser(admin, {
      email: uniqueEmail("rt-target"),
      name: "RtTarget",
      password: "abcdef-123456-rtt",
    });
    const targetClient = await loginAs(target.email, target.password);
    const created = await targetClient.sendJson<CreateTokenResponse>(
      "POST",
      "/api/profile/tokens",
      { name: "rt-token", scopes: [] },
    );

    const op = await createUser(admin, {
      email: uniqueEmail("rt-op"),
      name: "RtOp",
      password: "abcdef-123456-rto",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);

    const res = await opClient.call(`/api/admin/users/${target.id}/tokens/${created.token.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("operator cannot revoke another user's token via the self-service route either (404)", async () => {
    const admin = await loginAsBootstrap();
    const target = await createUser(admin, {
      email: uniqueEmail("ss-target"),
      name: "SsTarget",
      password: "abcdef-123456-sst",
    });
    const targetClient = await loginAs(target.email, target.password);
    const created = await targetClient.sendJson<CreateTokenResponse>(
      "POST",
      "/api/profile/tokens",
      { name: "ss-token", scopes: [] },
    );

    const op = await createUser(admin, {
      email: uniqueEmail("ss-op"),
      name: "SsOp",
      password: "abcdef-123456-sso",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);

    const res = await opClient.call(`/api/profile/tokens/${created.token.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
