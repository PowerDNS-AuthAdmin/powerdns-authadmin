/**
 * tests/integration/rbac/zone-scoped-roles.test.ts
 *
 * A role scoped to `zone:<name>` grants that zone and nothing else (ADR-0024).
 *
 * The scope is planted the way IdP group sync plants it: as an entry in the
 * session's `derived_permissions` snapshot (`{scopeType: "zone", scopeId,
 * permissions}`), which is exactly what a `dns-corp → zone-editor @
 * zone:<name>` mapping writes at sign-in. Driving a real OIDC/LDAP/SAML login
 * would add an IdP to the stack without exercising anything more of the
 * authorization path under test.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, resolveRoleId, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

const ZONE_EDITOR = [
  "zone.read",
  "zone.settings.read",
  "record.read",
  "record.create",
  "record.update",
  "record.delete",
] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

function upsertA(client: TestHttp, zone: string): Promise<Response> {
  return client.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
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
}

/** What IdP group sync stores for a zone-scoped mapping. */
async function plantZoneScope(
  userId: string,
  scopeId: string,
  permissions: readonly string[],
): Promise<void> {
  await dbQuery("UPDATE sessions SET derived_permissions = $2::jsonb WHERE user_id = $1", [
    userId,
    JSON.stringify([{ scopeType: "zone", scopeId, permissions }]),
  ]);
}

describe("zone-scoped roles grant their zone only", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("a zone-scoped Zone Editor edits its zone and is refused everywhere else", async () => {
    const admin = await loginAsBootstrap();
    const scoped = randomZone("scoped");
    const other = randomZone("other");
    await createZone(admin, scoped);
    await createZone(admin, other);

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("zone-scoped"),
      name: "Zone-scoped editor",
      password: "zone-scoped-pw-1234",
    });

    // No access before the scope lands.
    expect((await upsertA(client, scoped)).status).toBe(403);

    // Spelled the way an operator might type it in a mapping form - the
    // match canonicalises case and the trailing dot.
    await plantZoneScope(user.id, scoped.toUpperCase().replace(/\.$/, ""), ZONE_EDITOR);

    expect((await upsertA(client, scoped)).status).toBe(200);
    expect((await upsertA(client, other)).status).toBe(403);

    const exportOwn = await client.call(
      `/api/admin/pdns/zones/${encodeURIComponent(scoped)}/export?serverSlug=standalone`,
    );
    expect(exportOwn.status).not.toBe(403);
    const exportOther = await client.call(
      `/api/admin/pdns/zones/${encodeURIComponent(other)}/export?serverSlug=standalone`,
    );
    expect(exportOther.status).toBe(403);
  }, 30_000);

  it("a zone scope never opens zone creation or admin-wide endpoints", async () => {
    const admin = await loginAsBootstrap();
    const scoped = randomZone("scoped-create");
    await createZone(admin, scoped);

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("zone-scoped-create"),
      name: "Zone-scoped would-be creator",
      password: "zone-scoped-create-pw-1234",
    });
    await plantZoneScope(user.id, scoped, [
      ...ZONE_EDITOR,
      "zone.create",
      "user.read",
      "server.read",
      "audit.read",
    ]);

    const create = await client.call("/api/admin/pdns/zones", {
      method: "POST",
      json: { serverSlug: "standalone", name: randomZone("new"), kind: "Master", nameservers: NS },
    });
    expect(create.status).toBe(403);

    expect((await client.call("/api/admin/users")).status).toBe(403);
    expect((await client.call("/api/admin/pdns-servers")).status).toBe(403);
  }, 30_000);

  it("an admin-issued zone-scoped assignment grants that zone only", async () => {
    const admin = await loginAsBootstrap();
    const scoped = randomZone("assigned");
    const other = randomZone("assigned-other");
    await createZone(admin, scoped);
    await createZone(admin, other);

    const { user, client } = await createAndLogin(admin, {
      email: uniqueEmail("zone-assigned"),
      name: "Zone-assigned editor",
      password: "zone-assigned-pw-1234",
    });
    expect((await upsertA(client, scoped)).status).toBe(403);

    const assign = await admin.call(`/api/admin/users/${user.id}/role-assignments`, {
      method: "POST",
      json: {
        roleId: await resolveRoleId(admin, "zone-editor"),
        scopeType: "zone",
        // Typed loosely on purpose: the route stores the canonical name.
        scopeId: scoped.toUpperCase().replace(/\.$/, ""),
      },
    });
    expect(assign.status).toBe(201);
    const { assignment } = (await assign.json()) as { assignment: { scopeId: string } };
    expect(assignment.scopeId).toBe(scoped);

    expect((await upsertA(client, scoped)).status).toBe(200);
    expect((await upsertA(client, other)).status).toBe(403);
    expect((await client.call("/api/admin/users")).status).toBe(403);
  }, 30_000);

  it("an assignment to a zone no backend serves is accepted with a warning", async () => {
    const admin = await loginAsBootstrap();
    const { user } = await createAndLogin(admin, {
      email: uniqueEmail("zone-assigned-missing"),
      name: "Zone-assigned, zone missing",
      password: "zone-assigned-missing-pw-1234",
    });
    const res = await admin.call(`/api/admin/users/${user.id}/role-assignments`, {
      method: "POST",
      json: {
        roleId: await resolveRoleId(admin, "zone-editor"),
        scopeType: "zone",
        scopeId: randomZone("not-created"),
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toMatch(/No backend serves/);
  }, 30_000);

  it("rejects a zone target that is not a zone name", async () => {
    const admin = await loginAsBootstrap();
    const { user } = await createAndLogin(admin, {
      email: uniqueEmail("zone-assigned-bad"),
      name: "Zone-assigned, bad name",
      password: "zone-assigned-bad-pw-1234",
    });
    const res = await admin.call(`/api/admin/users/${user.id}/role-assignments`, {
      method: "POST",
      json: {
        roleId: await resolveRoleId(admin, "zone-editor"),
        scopeType: "zone",
        scopeId: "not a zone",
      },
    });
    expect(res.status).toBe(400);
  }, 30_000);
});
