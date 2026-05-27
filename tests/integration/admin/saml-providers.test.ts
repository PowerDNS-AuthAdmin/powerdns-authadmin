/**
 * tests/integration/admin/saml-providers.test.ts
 *
 * /api/admin/saml-providers — list / create / update / delete + slug
 * reservation. Mirrors the OIDC integration test shape; signature
 * verification against a real IdP needs a Keycloak SAML realm in the
 * docker-compose stack which is tracked separately.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface SamlProvider {
  id: string;
  slug: string;
  name: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string | null;
  signatureAlgorithm: string;
  nameIdFormat: string;
  claimEmail: string;
  claimName: string;
  claimGroups: string;
  enabled: boolean;
  requireSignedResponse: boolean;
  requireEncryptedAssertion: boolean;
  allowedEmailDomains: string[] | null;
}

const STUB_CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDdzCCAl+gAwIBAgIUSAMLIntegrationTestStubCertOnly000000000000wDQ",
  "YJKoZIhvcNAQELBQAwSTELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMRYwFAYDVQQK",
  "DA1JbnRlZ3JhdGlvblRlc3RDZXJ0",
  "-----END CERTIFICATE-----",
].join("\n");

const STUB_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDXVUDXVUDXVUDXVU",
  "DXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDX",
  "VUDXVUDXVUDXVUDXVUDXVUDXVUDXVUDXVU",
  "-----END PRIVATE KEY-----",
].join("\n");

function uniqueSamlSlug(prefix = "saml"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProvider(
  admin: Awaited<ReturnType<typeof loginAsBootstrap>>,
  overrides: Partial<{ slug: string; name: string; idpEntityId: string }> = {},
): Promise<SamlProvider> {
  const slug = overrides.slug ?? uniqueSamlSlug();
  const { provider } = await admin.sendJson<{ provider: SamlProvider }>(
    "POST",
    "/api/admin/saml-providers",
    {
      slug,
      name: overrides.name ?? "Test SAML",
      idpEntityId: overrides.idpEntityId ?? "https://idp.example.test/saml",
      idpSsoUrl: "https://idp.example.test/saml/sso",
      idpSigningCert: STUB_CERT,
      spSigningKey: STUB_PRIVATE_KEY,
      spSigningCert: STUB_CERT,
    },
  );
  return provider;
}

describe("/api/admin/saml-providers", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists existing providers", async () => {
    const admin = await loginAsBootstrap();
    const before = await admin.getJson<{ providers: SamlProvider[] }>("/api/admin/saml-providers");
    const created = await createProvider(admin);
    const after = await admin.getJson<{ providers: SamlProvider[] }>("/api/admin/saml-providers");
    expect(after.providers.length).toBe(before.providers.length + 1);
    expect(after.providers.map((p) => p.id)).toContain(created.id);
  });

  it("POST creates a provider and 201s with no secret material in the response", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSamlSlug("create");
    const res = await admin.call("/api/admin/saml-providers", {
      method: "POST",
      json: {
        slug,
        name: "Created SAML",
        idpEntityId: "https://idp.example.test/saml",
        idpSsoUrl: "https://idp.example.test/saml/sso",
        idpSigningCert: STUB_CERT,
        spSigningKey: STUB_PRIVATE_KEY,
        spSigningCert: STUB_CERT,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { provider: Record<string, unknown> };
    expect(body.provider["slug"]).toBe(slug);
    expect(body.provider).not.toHaveProperty("spSigningKeyEncrypted");
    expect(body.provider).not.toHaveProperty("spEncryptionKeyEncrypted");
  });

  it("POST reserves the slug in auth_provider_slugs", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSamlSlug("reserve");
    await createProvider(admin, { slug });
    const rows = await dbQuery<{ slug: string; provider_type: string }>(
      `SELECT slug, provider_type FROM auth_provider_slugs WHERE slug = $1`,
      [slug],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider_type).toBe("saml");
  });

  it("POST refuses a slug already taken by an OIDC provider", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSamlSlug("conflict");
    // Stake the slug for OIDC first.
    await admin.sendJson("POST", "/api/admin/oidc-providers", {
      slug,
      name: "Will Conflict",
      issuerUrl: "https://idp.example.test",
      clientId: "x",
      clientSecret: "y",
    });
    // SAML create with the same slug must 409.
    const res = await admin.call("/api/admin/saml-providers", {
      method: "POST",
      json: {
        slug,
        name: "Conflicting SAML",
        idpEntityId: "https://idp.example.test/saml",
        idpSsoUrl: "https://idp.example.test/saml/sso",
        idpSigningCert: STUB_CERT,
        spSigningKey: STUB_PRIVATE_KEY,
        spSigningCert: STUB_CERT,
      },
    });
    expect(res.status).toBe(409);
  });

  it("PATCH updates a provider's name", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    const { provider } = await admin.sendJson<{ provider: SamlProvider }>(
      "PATCH",
      `/api/admin/saml-providers/${created.id}`,
      { name: "Renamed SAML Provider" },
    );
    expect(provider.name).toBe("Renamed SAML Provider");
  });

  it("DELETE removes the provider and releases the slug", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    await admin.sendJson("DELETE", `/api/admin/saml-providers/${created.id}`);
    const { providers } = await admin.getJson<{ providers: SamlProvider[] }>(
      "/api/admin/saml-providers",
    );
    expect(providers.find((p) => p.id === created.id)).toBeUndefined();
    const rows = await dbQuery<{ slug: string }>(
      `SELECT slug FROM auth_provider_slugs WHERE slug = $1`,
      [created.slug],
    );
    expect(rows).toHaveLength(0);
  });

  it("GET /api/auth/saml/<slug>/metadata returns XML", async () => {
    const admin = await loginAsBootstrap();
    const created = await createProvider(admin);
    const res = await admin.call(`/api/auth/saml/${created.slug}/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toMatch(/samlmetadata/);
    const body = await res.text();
    expect(body).toMatch(/EntityDescriptor/);
  });
});
