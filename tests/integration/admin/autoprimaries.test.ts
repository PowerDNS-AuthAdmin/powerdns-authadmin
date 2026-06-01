/**
 * tests/integration/admin/autoprimaries.test.ts
 *
 * /api/admin/pdns/autoprimaries - POST + DELETE proxy through to the
 * selected PDNS backend. There is no DB row + no GET list - autoprimary
 * inventory lives entirely in PDNS. The route only audits the tuple +
 * delegates; tests verify the round-trip + audit emission.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

function uniqueNs(prefix = "ns-test"): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}.example.`;
}

function uniqueIp(): string {
  // Routable-looking but in the documentation block (RFC 5737) so it's
  // unambiguous test data. Vary the last octet to avoid duplicate-tuple
  // 409s across re-runs against the same backend.
  const oct = 1 + Math.floor(Math.random() * 250);
  return `198.51.100.${oct}`;
}

describe("/api/admin/pdns/autoprimaries", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST registers a (ip, nameserver, account) tuple on the default backend", async () => {
    const admin = await loginAsBootstrap();
    const ip = uniqueIp();
    const nameserver = uniqueNs();
    const body = await admin.sendJson<{ ok: boolean }>("POST", "/api/admin/pdns/autoprimaries", {
      ip,
      nameserver,
      account: "integration-test",
    });
    expect(body.ok).toBe(true);
    const qs = new URLSearchParams({ ip, nameserver }).toString();
    await admin.sendJson("DELETE", `/api/admin/pdns/autoprimaries?${qs}`);
  });

  it("DELETE removes a previously-registered tuple", async () => {
    const admin = await loginAsBootstrap();
    const ip = uniqueIp();
    const nameserver = uniqueNs("del");
    await admin.sendJson("POST", "/api/admin/pdns/autoprimaries", { ip, nameserver });
    const qs = new URLSearchParams({ ip, nameserver }).toString();
    const body = await admin.sendJson<{ ok: boolean }>(
      "DELETE",
      `/api/admin/pdns/autoprimaries?${qs}`,
    );
    expect(body.ok).toBe(true);
  });

  it("POST with invalid IP returns 400", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/pdns/autoprimaries", {
      method: "POST",
      json: { ip: "not-an-ip!", nameserver: uniqueNs() },
    });
    expect(res.status).toBe(400);
  });

  it("audit log records autoprimary.create and autoprimary.delete", async () => {
    const admin = await loginAsBootstrap();
    const ip = uniqueIp();
    const nameserver = uniqueNs("audit");
    await admin.sendJson("POST", "/api/admin/pdns/autoprimaries", { ip, nameserver });
    const qs = new URLSearchParams({ ip, nameserver }).toString();
    await admin.sendJson("DELETE", `/api/admin/pdns/autoprimaries?${qs}`);
    const rows = await dbQuery<{ action: string; after: Record<string, unknown> | null }>(
      "SELECT action, after FROM audit_log WHERE action IN ('autoprimary.create', 'autoprimary.delete') ORDER BY ts DESC LIMIT 10",
    );
    const matching = rows.filter((r) => {
      const after = r.after as { ip?: string; nameserver?: string } | null;
      return after?.ip === ip || after?.nameserver === nameserver;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("autoprimary.create");
    expect(actions).toContain("autoprimary.delete");
    // Sanity: at least the create row's after-snapshot held the tuple.
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });
});
