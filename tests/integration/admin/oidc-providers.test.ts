/**
 * tests/integration/admin/oidc-providers.test.ts
 *
 * /api/admin/oidc-providers — list / create / update / delete + on-demand
 * IdP probe. The fake issuer URL we use isn't a real OIDC IdP so the probe
 * returns ok: false; the route shape is the same either way.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface OidcProvider {
  id: string;
  slug: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  scopes: string;
  claimEmail: string;
  claimName: string;
  enabled: boolean;
  requireEmailVerified: boolean;
  allowedEmailDomains: string[] | null;
  iconUrl: string | null;
}

function uniqueOidcSlug(prefix = "oidc"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProvider(
  admin: Awaited<ReturnType<typeof loginAsBootstrap>>,
  overrides: Partial<{ slug: string; name: string; issuerUrl: string }> = {},
): Promise<OidcProvider> {
  const slug = overrides.slug ?? uniqueOidcSlug();
  const { provider } = await admin.sendJson<{ provider: OidcProvider }>(
    "POST",
    "/api/admin/oidc-providers",
    {
      slug,
      name: overrides.name ?? "Test OIDC",
      issuerUrl: overrides.issuerUrl ?? "https://idp.example.test",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    },
  );
  return provider;
}

describe("/api/admin/oidc-providers", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists existing providers", async () => {
    const admin = await loginAsBootstrap();
    const before = await admin.getJson<{ providers: OidcProvider[] }>("/api/admin/oidc-providers");
    const created = await createProvider(admin);
    const after = await admin.getJson<{ providers: OidcProvider[] }>("/api/admin/oidc-providers");
    expect(after.providers.length).toBe(before.providers.length + 1);
    expect(after.providers.map((p) => p.id)).toContain(created.id);
  });

  it("POST creates a provider and 201s with no client_secret in the response", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueOidcSlug("create");
    const res = await admin.call("/api/admin/oidc-providers", {
      method: "POST",
      json: {
        slug,
        name: "Created",
        issuerUrl: "https://idp.example.test",
        clientId: "id",
        clientSecret: "secret-value",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { provider: Record<string, unknown> };
    expect(body.provider["slug"]).toBe(slug);
    expect(body.provider).not.toHaveProperty("clientSecretEncrypted");
    expect(body.provider).not.toHaveProperty("clientSecret");
  });

  it("GET /api/admin/oidc-providers/[id] — route is not exposed; expect 404 or 405", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    const res = await admin.call(`/api/admin/oidc-providers/${created.id}`);
    expect([404, 405]).toContain(res.status);
  });

  it("PATCH updates a provider's name", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    const { provider } = await admin.sendJson<{ provider: OidcProvider }>(
      "PATCH",
      `/api/admin/oidc-providers/${created.id}`,
      { name: "Renamed Provider" },
    );
    expect(provider.name).toBe("Renamed Provider");
  });

  it("DELETE removes the provider", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    await admin.sendJson("DELETE", `/api/admin/oidc-providers/${created.id}`);
    const { providers } = await admin.getJson<{ providers: OidcProvider[] }>(
      "/api/admin/oidc-providers",
    );
    expect(providers.find((p) => p.id === created.id)).toBeUndefined();
  });

  it("POST /api/admin/oidc-providers/[id]/test returns a shaped probe result", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin, {
      issuerUrl: "https://idp-that-does-not-resolve.example.invalid",
    });
    const res = await admin.call(`/api/admin/oidc-providers/${created.id}/test`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string; hint?: string };
    expect(typeof body.ok).toBe("boolean");
    if (!body.ok) {
      expect(typeof body.reason).toBe("string");
      expect(typeof body.hint).toBe("string");
    }
  });

  it("audit log records oidc.provider.created and oidc.provider.updated", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    await admin.sendJson("PATCH", `/api/admin/oidc-providers/${created.id}`, {
      name: "Updated Name",
    });
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_type = 'oidc_provider' AND resource_id = $1 ORDER BY ts",
      [created.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("oidc.provider.created");
    expect(actions).toContain("oidc.provider.updated");
  });
});
