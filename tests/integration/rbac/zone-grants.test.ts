/**
 * tests/integration/rbac/zone-grants.test.ts
 *
 * Per-zone permission grants. A read-only-globally user gets a grant
 * on a single zone and now has the granted permissions for that
 * (server, zone) only. Zones outside the grant remain 403. The grant
 * is revocable.
 *
 * No team-membership wiring is required — `zone_grants` is a direct
 * (user, server, zone, permissions) tuple. The team-scope assignment
 * step in the brief is folded into the zone_grant itself.
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

async function getStandaloneId(admin: TestHttp): Promise<string> {
  const { servers } = await admin.getJson<{
    servers: Array<{ id: string; slug: string }>;
  }>("/api/admin/pdns-servers");
  const standalone = servers.find((s) => s.slug === "standalone");
  if (!standalone) throw new Error("standalone server not found");
  return standalone.id;
}

describe("zone grants — per-zone permission grants", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("granted user can patch records on the granted zone; ungranted zone returns 403", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const granted = randomZone("granted");
    const otherZone = randomZone("ungranted");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: granted,
      kind: "Master",
      nameservers: NS,
    });
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: otherZone,
      kind: "Master",
      nameservers: NS,
    });

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("grantee"),
      name: "Grantee",
      password: "grantee-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });

    // Grant the user record.update on the `granted` zone only.
    await admin.sendJson("POST", `/api/admin/users/${user.id}/zone-grants`, {
      serverId: standaloneId,
      zoneName: granted,
      permissions: ["record.update", "record.create", "zone.read"],
    });

    // Grantee can now PATCH records on the granted zone.
    const ok = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(granted)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${granted}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.30" }],
          },
        ],
      },
    });
    expect(ok.status).toBe(200);

    // …but not the ungranted zone.
    const denied = await client.call(
      `/api/admin/pdns/zones/${encodeURIComponent(otherZone)}/rrsets`,
      {
        method: "PATCH",
        json: {
          serverSlug: "standalone",
          changes: [
            {
              kind: "upsert",
              name: `www.${otherZone}`,
              type: "A",
              ttl: 60,
              records: [{ content: "192.0.2.31" }],
            },
          ],
        },
      },
    );
    expect(denied.status).toBe(403);
  }, 30_000);

  it("DELETE on the grant revokes access — the user loses PATCH on the zone", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("revoke");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("revokee"),
      name: "Revokee",
      password: "revokee-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });

    const { grant } = await admin.sendJson<{ grant: { id: string } }>(
      "POST",
      `/api/admin/users/${user.id}/zone-grants`,
      {
        serverId: standaloneId,
        zoneName: zone,
        permissions: ["record.update", "record.create"],
      },
    );

    // Pre-revoke: PATCH succeeds.
    const before = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.40" }],
          },
        ],
      },
    });
    expect(before.status).toBe(200);

    // Revoke.
    await admin.sendJson("DELETE", `/api/admin/users/${user.id}/zone-grants/${grant.id}`);

    // Post-revoke: PATCH 403.
    const after = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.41" }],
          },
        ],
      },
    });
    expect(after.status).toBe(403);
  }, 30_000);

  it("GET /api/admin/users/[id]/zone-grants lists the user's grants", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("listed");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    const { user } = await createAndLogin(admin, {
      email: uniqueEmail("listed"),
      name: "Listed",
      password: "listed-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    await admin.sendJson("POST", `/api/admin/users/${user.id}/zone-grants`, {
      serverId: standaloneId,
      zoneName: zone,
      permissions: ["record.update"],
    });
    const { grants } = await admin.getJson<{
      grants: Array<{ zoneName: string; permissions: string[] }>;
    }>(`/api/admin/users/${user.id}/zone-grants`);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.zoneName).toBe(zone);
    expect(grants[0]!.permissions).toContain("record.update");
  }, 30_000);

  it("a duplicate grant POST returns 409", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("dup");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    const { user } = await createAndLogin(admin, {
      email: uniqueEmail("dup"),
      name: "Dup",
      password: "dup-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const path = `/api/admin/users/${user.id}/zone-grants`;
    await admin.sendJson("POST", path, {
      serverId: standaloneId,
      zoneName: zone,
      permissions: ["record.update"],
    });
    const res = await admin.call(path, {
      method: "POST",
      json: {
        serverId: standaloneId,
        zoneName: zone,
        permissions: ["record.delete"],
      },
    });
    expect(res.status).toBe(409);
  }, 30_000);
});
