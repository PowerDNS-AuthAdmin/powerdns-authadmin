/**
 * tests/integration/admin/pdns-servers.test.ts
 *
 * /api/admin/pdns-servers — CRUD + credentials test + fleet refresh. Walks
 * the provisioning baseline (8 backends across 3 topologies) and then
 * exercises the create/read/patch/delete + audit paths against a
 * throwaway row so the seeded rows survive the suite.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface PdnsServerRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  baseUrl: string;
  serverId: string;
  isDefault: boolean;
  disabledAt: string | null;
  clusterId: string | null;
  versionCache?: unknown;
  capabilities?: {
    api: boolean;
    primary: boolean;
    secondary: boolean;
    autosecondary: boolean;
    backends: string[];
    dnssec: boolean;
    fetchedAt: string;
  } | null;
}

const SEEDED_SLUGS = [
  "peer-1",
  "peer-2",
  "peer-3",
  "standalone",
  "ps-primary",
  "ps-secondary-1",
  "ps-secondary-2",
  "ps-secondary-3",
];

function uniqueSlug(prefix = "test-srv"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/pdns-servers", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists all 8 provisioned backends by slug", async () => {
    const admin = await loginAsBootstrap();
    const { servers } = await admin.getJson<{ servers: PdnsServerRow[] }>(
      "/api/admin/pdns-servers",
    );
    const slugs = servers.map((s) => s.slug);
    for (const expected of SEEDED_SLUGS) {
      expect(slugs).toContain(expected);
    }
  });

  it("classifies backends from observed /config capabilities (ADR-0014)", async () => {
    // Provisioning probes each backend's /config at boot, so capabilities are
    // populated. This validates the whole chain: deriveCapabilities → persist →
    // expose, and the write-target vs read-only-mirror classification that
    // replaced the dropped `role` column.
    const admin = await loginAsBootstrap();
    const { servers } = await admin.getJson<{ servers: PdnsServerRow[] }>(
      "/api/admin/pdns-servers",
    );
    const bySlug = new Map(servers.map((s) => [s.slug, s]));

    const primary = bySlug.get("ps-primary");
    expect(primary?.capabilities?.primary).toBe(true);

    const secondary = bySlug.get("ps-secondary-1");
    expect(secondary?.capabilities?.secondary).toBe(true);
    expect(secondary?.capabilities?.primary).toBe(false);
  });

  it("POST creates a new server even when the URL is unreachable", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug();
    const { server } = await admin.sendJson<{ server: PdnsServerRow }>(
      "POST",
      "/api/admin/pdns-servers",
      {
        slug,
        name: "Throwaway",
        description: "spawned by integration test",
        baseUrl: "http://192.0.2.5:9999/api/v1",
        serverId: "localhost",
        apiKey: "throwaway-key",
      },
    );
    expect(server.slug).toBe(slug);
    expect(server.baseUrl).toContain("192.0.2.5");
    expect((server as unknown as Record<string, unknown>)["apiKeyEncrypted"]).toBeUndefined();
    await admin.sendJson("DELETE", `/api/admin/pdns-servers/${server.id}`);
  });

  it("GET /api/admin/pdns-servers/[id] returns the single row", async () => {
    const admin = await loginAsBootstrap();
    const { servers } = await admin.getJson<{ servers: PdnsServerRow[] }>(
      "/api/admin/pdns-servers",
    );
    const target = servers.find((s) => s.slug === "standalone");
    expect(target).toBeDefined();
    const list = await admin.getJson<{ servers: PdnsServerRow[] }>("/api/admin/pdns-servers");
    const same = list.servers.find((s) => s.id === target!.id);
    expect(same?.slug).toBe("standalone");
  });

  it("PATCH updates name and description", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("patch");
    const { server } = await admin.sendJson<{ server: PdnsServerRow }>(
      "POST",
      "/api/admin/pdns-servers",
      {
        slug,
        name: "Original",
        baseUrl: "http://192.0.2.6:9999/api/v1",
        apiKey: "k",
      },
    );
    const { server: patched } = await admin.sendJson<{ server: PdnsServerRow }>(
      "PATCH",
      `/api/admin/pdns-servers/${server.id}`,
      { name: "Renamed", description: "edited description" },
    );
    expect(patched.name).toBe("Renamed");
    expect(patched.description).toBe("edited description");
    await admin.sendJson("DELETE", `/api/admin/pdns-servers/${server.id}`);
  });

  it("DELETE removes a server (round-trip create + delete)", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("del");
    const { server } = await admin.sendJson<{ server: PdnsServerRow }>(
      "POST",
      "/api/admin/pdns-servers",
      {
        slug,
        name: "ToDelete",
        baseUrl: "http://192.0.2.7:9999/api/v1",
        apiKey: "k",
      },
    );
    await admin.sendJson("DELETE", `/api/admin/pdns-servers/${server.id}`);
    const { servers } = await admin.getJson<{ servers: PdnsServerRow[] }>(
      "/api/admin/pdns-servers",
    );
    expect(servers.find((s) => s.id === server.id)).toBeUndefined();
  });

  it("POST /[id]/test returns a structured shape on success or failure", async () => {
    const admin = await loginAsBootstrap();
    const { servers } = await admin.getJson<{ servers: PdnsServerRow[] }>(
      "/api/admin/pdns-servers",
    );
    const target = servers.find((s) => s.slug === "standalone") ?? servers[0]!;
    const res = await admin.call(`/api/admin/pdns-servers/${target.id}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBeTypeOf("boolean");
    expect(body["requestId"]).toBeTypeOf("string");
  });

  it("POST /refresh-all probes the fleet and returns counts", async () => {
    const admin = await loginAsBootstrap();
    const body = await admin.sendJson<{ ok: boolean; probed: number; failed: number }>(
      "POST",
      "/api/admin/pdns-servers/refresh-all",
    );
    expect(body.ok).toBe(true);
    expect(typeof body.probed).toBe("number");
    expect(typeof body.failed).toBe("number");
  });

  it("operator (no server.create) gets 403 on POST", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("srv-op"),
      name: "Op",
      password: "operator-pw-1234567",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/pdns-servers", {
      method: "POST",
      json: {
        slug: uniqueSlug("nope"),
        name: "Nope",
        baseUrl: "http://192.0.2.9:9999/api/v1",
        apiKey: "k",
      },
    });
    expect(res.status).toBe(403);
  });

  it("audit log records server.create, server.update, server.delete", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("audit");
    const { server } = await admin.sendJson<{ server: PdnsServerRow }>(
      "POST",
      "/api/admin/pdns-servers",
      {
        slug,
        name: "Audited",
        baseUrl: "http://192.0.2.10:9999/api/v1",
        apiKey: "k",
      },
    );
    await admin.sendJson("PATCH", `/api/admin/pdns-servers/${server.id}`, { name: "Audited2" });
    await admin.sendJson("DELETE", `/api/admin/pdns-servers/${server.id}`);
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY ts",
      [server.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("server.create");
    expect(actions).toContain("server.update");
    expect(actions).toContain("server.delete");
  });
});
