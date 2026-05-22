/**
 * tests/integration/admin/tsig-keys.test.ts
 *
 * /api/admin/pdns/tsig-keys — POST creates a TSIG key on the default
 * PDNS backend and returns a single-use revealToken instead of the raw
 * secret. The sibling /reveal endpoint redeems the token for the
 * plaintext as text/plain. DELETE removes the key from the backend. No
 * GET list/detail is exposed in this slice.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface TsigCreateResponse {
  ok: boolean;
  tsigKey: { id: string; name: string; algorithm: string };
  revealToken: string;
  expiresInSec: number;
}

function uniqueTsigName(prefix = "test-tsig"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/pdns/tsig-keys", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST creates a TSIG key and returns a revealToken (no plaintext in body)", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName();
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    expect(created.ok).toBe(true);
    expect(created.tsigKey.id).toBeTruthy();
    expect(created.revealToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((created.tsigKey as Record<string, unknown>)["key"]).toBeUndefined();
    expect(JSON.stringify(created)).not.toMatch(/"key"\s*:/);
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
  });

  it("POST /[id]/reveal returns the plaintext secret as text/plain exactly once", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("reveal");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    const first = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`,
      { method: "POST", json: { token: created.revealToken } },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type") ?? "").toContain("text/plain");
    const secret = await first.text();
    expect(secret.length).toBeGreaterThan(0);

    const second = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`,
      { method: "POST", json: { token: created.revealToken } },
    );
    expect(second.status).toBe(404);
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
  });

  it("DELETE removes the key — a follow-up DELETE returns 404", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("del");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
    const res = await admin.call(
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("audit log records tsig.create, tsig.reveal, tsig.delete", async () => {
    const admin = await loginAsBootstrap();
    const name = uniqueTsigName("audit");
    const created = await admin.sendJson<TsigCreateResponse>("POST", "/api/admin/pdns/tsig-keys", {
      name,
      algorithm: "hmac-sha256",
    });
    await admin.call(`/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}/reveal`, {
      method: "POST",
      json: { token: created.revealToken },
    });
    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/tsig-keys/${encodeURIComponent(created.tsigKey.id)}`,
    );
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_type = 'tsig' AND resource_id = $1 ORDER BY ts",
      [created.tsigKey.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("tsig.create");
    expect(actions).toContain("tsig.reveal");
    expect(actions).toContain("tsig.delete");
  });
});
