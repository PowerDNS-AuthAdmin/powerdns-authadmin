/**
 * tests/integration/rbac/role-matrix.test.ts
 *
 * Walks a representative cross-section of routes for each system role
 * and asserts the expected HTTP outcome:
 *   - super-admin  → 2xx for every checked surface
 *   - operator     → 2xx for zone ops; 403 on user/oidc/settings admin
 *   - zone-editor  → 2xx for zone reads + record edits; 403 on zone
 *                    create / user mgmt / settings
 *   - read-only    → 2xx for GETs; 403 for mutations
 *
 * The "team-owner restricted outside team scope" case lives in
 * `zone-grants.test.ts` since the scope check is grant-driven.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

async function expectStatus(
  client: TestHttp,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  path: string,
  expected: number[],
  json?: unknown,
): Promise<void> {
  const res = await client.call(path, { method, ...(json !== undefined ? { json } : {}) });
  expect(
    expected,
    `${method} ${path} → ${res.status} (expected one of ${expected.join(", ")})`,
  ).toContain(res.status);
}

describe("RBAC role matrix", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("super-admin can reach every checked admin route", async () => {
    const admin = await loginAsBootstrap();
    await expectStatus(admin, "GET", "/api/admin/users", [200]);
    await expectStatus(admin, "GET", "/api/admin/roles", [200]);
    await expectStatus(admin, "GET", "/api/admin/teams", [200]);
    await expectStatus(admin, "GET", "/api/admin/settings", [200]);
    await expectStatus(admin, "GET", "/api/admin/oidc-providers", [200]);
    await expectStatus(admin, "GET", "/api/admin/pdns-servers", [200]);
    await expectStatus(admin, "GET", "/api/admin/zone-templates", [200]);
  });

  it("operator: 2xx on zones+templates; 403 on users/oidc/settings.write", async () => {
    const admin = await loginAsBootstrap();
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("op-matrix"),
      name: "Op Matrix",
      password: "op-matrix-pw-1234",
      roleSlug: SYSTEM_ROLES.operator,
    });
    // 2xx surfaces
    await expectStatus(client, "GET", "/api/admin/zone-templates", [200]);
    await expectStatus(client, "GET", "/api/admin/pdns-servers", [200]);
    // Operator can create a zone.
    await expectStatus(client, "POST", "/api/admin/pdns/zones", [201], {
      serverSlug: "standalone",
      name: randomZone("op-create"),
      kind: "Master",
      nameservers: NS,
    });
    // Restricted surfaces
    await expectStatus(client, "GET", "/api/admin/oidc-providers", [403]);
    await expectStatus(client, "GET", "/api/admin/audit/export", [403, 405]);
    await expectStatus(client, "PATCH", "/api/admin/settings", [403], { brandName: "x" });
    await expectStatus(client, "POST", "/api/admin/users", [403], {
      email: uniqueEmail("nope"),
      name: "Nope",
      password: "abcdef-123456-zzz",
    });
  }, 30_000);

  it("zone-editor: can edit records on an existing zone; cannot create zones", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("ze-fixture");
    // Bootstrap creates a fixture zone so the editor has something to patch.
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("ze-matrix"),
      name: "ZE Matrix",
      password: "zone-editor-matrix-pw-1234",
      roleSlug: SYSTEM_ROLES.zoneEditor,
    });
    // Reads
    await expectStatus(client, "GET", "/api/admin/pdns-servers", [200]);
    await expectStatus(
      client,
      "GET",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/export?serverSlug=standalone`,
      [200],
    );
    // Record edit OK
    await expectStatus(
      client,
      "PATCH",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`,
      [200],
      {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.7" }],
          },
        ],
      },
    );
    // Zone create - denied
    await expectStatus(client, "POST", "/api/admin/pdns/zones", [403], {
      serverSlug: "standalone",
      name: randomZone("ze-denied"),
      kind: "Master",
      nameservers: NS,
    });
    // Admin surfaces - denied
    await expectStatus(client, "GET", "/api/admin/oidc-providers", [403]);
  }, 30_000);

  it("read-only: 2xx on GETs; 403 on every mutation", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("ro-fixture");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    const { client } = await createAndLogin(admin, {
      email: uniqueEmail("ro-matrix"),
      name: "RO Matrix",
      password: "ro-matrix-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    // GETs the role grants:
    await expectStatus(client, "GET", "/api/admin/zone-templates", [200]);
    await expectStatus(client, "GET", "/api/admin/pdns-servers", [200]);
    await expectStatus(
      client,
      "GET",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/export?serverSlug=standalone`,
      [200],
    );
    // Mutations - denied
    await expectStatus(client, "POST", "/api/admin/pdns/zones", [403], {
      serverSlug: "standalone",
      name: randomZone("ro-denied"),
      kind: "Master",
      nameservers: NS,
    });
    await expectStatus(
      client,
      "PATCH",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`,
      [403],
      {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.7" }],
          },
        ],
      },
    );
    await expectStatus(client, "GET", "/api/admin/oidc-providers", [403]);
  }, 30_000);
});
