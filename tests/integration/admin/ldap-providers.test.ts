/**
 * tests/integration/admin/ldap-providers.test.ts
 *
 * /api/admin/ldap-providers - list / create / update / delete. We don't
 * stand up a real OpenLDAP container in this slice; that's a follow-up.
 * The cases below pin the admin CRUD path + the slug-reservation
 * handshake with `auth_provider_slugs` (cross-type uniqueness).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface LdapProvider {
  id: string;
  slug: string;
  name: string;
  serverUrl: string;
  startTls: boolean;
  bindDn: string;
  userSearchBase: string;
  userSearchFilter: string;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  groupAttr: string;
  claimEmail: string;
  claimName: string;
  enabled: boolean;
  allowedEmailDomains: string[] | null;
  tlsCaCertSet: boolean;
}

function uniqueLdapSlug(prefix = "ldap"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProvider(
  admin: Awaited<ReturnType<typeof loginAsBootstrap>>,
  overrides: Partial<{ slug: string; name: string; serverUrl: string; startTls: boolean }> = {},
): Promise<LdapProvider> {
  const slug = overrides.slug ?? uniqueLdapSlug();
  // Default to an ldaps:// URL - the validator refuses plain ldap://
  // without start_tls or the env opt-in, and we want this helper to
  // give back a working row without hitting that branch.
  const { provider } = await admin.sendJson<{ provider: LdapProvider }>(
    "POST",
    "/api/admin/ldap-providers",
    {
      slug,
      name: overrides.name ?? "Test LDAP",
      serverUrl: overrides.serverUrl ?? "ldaps://ldap.example.test:636",
      startTls: overrides.startTls ?? false,
      bindDn: "CN=svc,DC=example,DC=test",
      bindPassword: "test-bind-password",
      userSearchBase: "OU=Users,DC=example,DC=test",
    },
  );
  return provider;
}

describe("/api/admin/ldap-providers", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists existing providers", async () => {
    const admin = await loginAsBootstrap();
    const before = await admin.getJson<{ providers: LdapProvider[] }>("/api/admin/ldap-providers");
    const created = await createProvider(admin);
    const after = await admin.getJson<{ providers: LdapProvider[] }>("/api/admin/ldap-providers");
    expect(after.providers.length).toBe(before.providers.length + 1);
    expect(after.providers.map((p) => p.id)).toContain(created.id);
  });

  it("POST creates a provider; the bind password never round-trips through the API", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueLdapSlug("create");
    const res = await admin.call("/api/admin/ldap-providers", {
      method: "POST",
      json: {
        slug,
        name: "Created",
        serverUrl: "ldaps://ldap.example.test:636",
        bindDn: "CN=svc,DC=example,DC=test",
        bindPassword: "highly-sensitive-pw",
        userSearchBase: "OU=Users,DC=example,DC=test",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { provider: Record<string, unknown> };
    expect(body.provider["slug"]).toBe(slug);
    expect(body.provider).not.toHaveProperty("bindPasswordEncrypted");
    expect(body.provider).not.toHaveProperty("bindPassword");
    // The CA cert bytes are never returned either - operators see only the
    // "is one set" flag.
    expect(body.provider).not.toHaveProperty("tlsCaCert");
    expect(body.provider).toHaveProperty("tlsCaCertSet", false);
  });

  it("POST refuses plain ldap:// without start_tls", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueLdapSlug("insecure");
    const res = await admin.call("/api/admin/ldap-providers", {
      method: "POST",
      json: {
        slug,
        name: "Insecure",
        serverUrl: "ldap://ldap.example.test:389",
        bindDn: "CN=svc,DC=example,DC=test",
        bindPassword: "x",
        userSearchBase: "OU=Users,DC=example,DC=test",
        startTls: false,
      },
    });
    // ValidationError → 400 with fieldErrors carrying the URL message.
    expect(res.status).toBe(400);
  });

  it("POST refuses a slug already taken by an OIDC provider (cross-type guard)", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueLdapSlug("collide");
    // Reserve the slug as OIDC first.
    await admin.sendJson("POST", "/api/admin/oidc-providers", {
      slug,
      name: "OIDC holder",
      issuerUrl: "https://idp.example.test",
      clientId: "id",
      clientSecret: "secret",
    });
    const res = await admin.call("/api/admin/ldap-providers", {
      method: "POST",
      json: {
        slug,
        name: "LDAP attempt",
        serverUrl: "ldaps://ldap.example.test:636",
        bindDn: "CN=svc,DC=example,DC=test",
        bindPassword: "x",
        userSearchBase: "OU=Users,DC=example,DC=test",
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already used by a OIDC provider/i);
  });

  it("PATCH updates a provider's name without rotating the password", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    const { provider } = await admin.sendJson<{ provider: LdapProvider }>(
      "PATCH",
      `/api/admin/ldap-providers/${created.id}`,
      { name: "Renamed LDAP" },
    );
    expect(provider.name).toBe("Renamed LDAP");
  });

  it("DELETE removes the provider AND releases the slug for reuse", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueLdapSlug("releaseable");
    const created = await createProvider(admin, { slug });
    await admin.sendJson("DELETE", `/api/admin/ldap-providers/${created.id}`);
    // Re-create under the SAME slug - only works if the cross-type
    // reservation was released.
    const recreated = await createProvider(admin, { slug });
    expect(recreated.slug).toBe(slug);
    expect(recreated.id).not.toBe(created.id);
  });

  it("audit log records ldap.provider.created and ldap.provider.updated", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    await admin.sendJson("PATCH", `/api/admin/ldap-providers/${created.id}`, {
      name: "Updated Name",
    });
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_type = 'ldap_provider' AND resource_id = $1 ORDER BY ts",
      [created.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("ldap.provider.created");
    expect(actions).toContain("ldap.provider.updated");
  });
});
