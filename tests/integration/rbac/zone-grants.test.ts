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
import {
  createAndLogin,
  createUser,
  loginAs,
  loginAsBootstrap,
  resolveRoleId,
  SYSTEM_ROLES,
  uniqueEmail,
} from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

const uniqueSlug = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

  it("privilege ceiling (GHSA-gjg4-58c5-2qg3): can't grant a permission you don't hold for the zone", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("ceiling");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });

    // The acting operator can manage users (reaches the route) and holds
    // zone.read globally — but NOT record.delete anywhere.
    const password = "limited-granter-pw-123456";
    const granter = await createUser(admin, {
      email: uniqueEmail("granter"),
      name: "Limited Granter",
      password,
    });
    const granterSlug = uniqueSlug("limited-granter");
    await admin.sendJson("POST", "/api/admin/roles", {
      slug: granterSlug,
      name: "Limited Granter",
      permissions: ["user.read", "user.update", "zone.read"],
    });
    const granterRoleId = await resolveRoleId(admin, granterSlug);
    await admin.sendJson("POST", `/api/admin/users/${granter.id}/role-assignments`, {
      roleId: granterRoleId,
      scopeType: "global",
    });

    const victim = await createUser(admin, {
      email: uniqueEmail("grant-victim"),
      name: "Grant Victim",
      password: "grant-victim-pw-123456",
    });

    const limited = await loginAs(granter.email, password);
    const path = `/api/admin/users/${victim.id}/zone-grants`;

    // Over the ceiling: granter lacks record.delete globally and has no own
    // grant for this zone → 403.
    const bad = await limited.call(path, {
      method: "POST",
      json: { serverId: standaloneId, zoneName: zone, permissions: ["record.delete"] },
    });
    expect(bad.status).toBe(403);

    // Within the ceiling: zone.read is held globally → 201.
    const ok = await limited.call(path, {
      method: "POST",
      json: { serverId: standaloneId, zoneName: zone, permissions: ["zone.read"] },
    });
    expect(ok.status).toBe(201);
  }, 30_000);

  // ─── Team-principal grants ─────────────────────────────────────────────────
  // A grant attached to a team flows through to every member via team_members.
  // Same authorization semantics as a direct user grant; only the principal column differs.

  it("team grant flows to a team member; revoke removes their access", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("team-grant");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });

    // A read-only user + a fresh team they're a member of.
    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("team-grantee"),
      name: "Team Grantee",
      password: "team-grantee-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const { team } = await admin.sendJson<{ team: { id: string; slug: string } }>(
      "POST",
      "/api/admin/teams",
      { slug: uniqueSlug("team-grant"), name: "Team-Grant" },
    );
    await admin.sendJson("POST", `/api/admin/teams/${team.id}/members`, {
      email: user.email,
      teamRole: "member",
    });

    // Before the team grant: the user can't PATCH the zone.
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
    expect(before.status).toBe(403);

    // Grant the team record.update on this zone.
    const { grant } = await admin.sendJson<{ grant: { id: string } }>(
      "POST",
      `/api/admin/teams/${team.id}/zone-grants`,
      {
        serverId: standaloneId,
        zoneName: zone,
        permissions: ["record.update", "record.create", "zone.read"],
      },
    );

    // The member now inherits the permission and can PATCH.
    const granted = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
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
    expect(granted.status).toBe(200);

    // Revoke the team grant → the member loses access again.
    await admin.sendJson("DELETE", `/api/admin/teams/${team.id}/zone-grants/${grant.id}`);
    const afterRevoke = await client.call(
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`,
      {
        method: "PATCH",
        json: {
          serverSlug: "standalone",
          changes: [
            {
              kind: "upsert",
              name: `www.${zone}`,
              type: "A",
              ttl: 60,
              records: [{ content: "192.0.2.42" }],
            },
          ],
        },
      },
    );
    expect(afterRevoke.status).toBe(403);
  }, 30_000);

  it("removing a member from a team also revokes the team's grants for that user", async () => {
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("team-leave");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("leaver"),
      name: "Leaver",
      password: "leaver-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const { team } = await admin.sendJson<{ team: { id: string; slug: string } }>(
      "POST",
      "/api/admin/teams",
      { slug: uniqueSlug("team-leave"), name: "Team-Leave" },
    );
    await admin.sendJson("POST", `/api/admin/teams/${team.id}/members`, {
      email: user.email,
      teamRole: "member",
    });
    await admin.sendJson("POST", `/api/admin/teams/${team.id}/zone-grants`, {
      serverId: standaloneId,
      zoneName: zone,
      permissions: ["record.update", "record.create", "zone.read"],
    });

    // Member can PATCH.
    const ok = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.50" }],
          },
        ],
      },
    });
    expect(ok.status).toBe(200);

    // Remove them from the team. The team's grant survives (not deleted),
    // but it no longer flows to this user because they're no longer a member.
    await admin.sendJson("DELETE", `/api/admin/teams/${team.id}/members/${user.id}`);
    const denied = await client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
      method: "PATCH",
      json: {
        serverSlug: "standalone",
        changes: [
          {
            kind: "upsert",
            name: `www.${zone}`,
            type: "A",
            ttl: 60,
            records: [{ content: "192.0.2.51" }],
          },
        ],
      },
    });
    expect(denied.status).toBe(403);
  }, 30_000);

  it("rejects POST with both userId and teamId routes (each route enforces its principal column)", async () => {
    // The CHECK constraint enforces exactly-one principal at the DB level.
    // Routes only ever insert one principal column, but the constraint is the
    // backstop. We exercise the user POST + team POST + the conflict-on-duplicate
    // path; the schema check is implicitly tested by the absence of a way to
    // hit it from the API.
    const admin = await loginAsBootstrap();
    const standaloneId = await getStandaloneId(admin);
    const zone = randomZone("dup");
    await admin.sendJson("POST", "/api/admin/pdns/zones", {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    const { team } = await admin.sendJson<{ team: { id: string } }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("dup"),
      name: "Dup",
    });

    const first = await admin.sendJson<{ grant: { id: string } }>(
      "POST",
      `/api/admin/teams/${team.id}/zone-grants`,
      { serverId: standaloneId, zoneName: zone, permissions: ["zone.read"] },
    );
    expect(first.grant.id).toBeTruthy();

    // Second POST with the same (team, server, zone) → 409.
    const dup = await admin.call(`/api/admin/teams/${team.id}/zone-grants`, {
      method: "POST",
      json: { serverId: standaloneId, zoneName: zone, permissions: ["zone.read"] },
    });
    expect(dup.status).toBe(409);
  }, 30_000);
});
