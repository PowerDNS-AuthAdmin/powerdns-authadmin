/**
 * tests/integration/admin/oidc-group-mapping-ceiling.test.ts
 *
 * GHSA-wf29-rmhc-rqc9 — the OIDC group→role mapping privilege ceiling, driven
 * over HTTP. A holder of `oidc.manage` must not be able to wire a group to a
 * role granting permissions they don't hold globally (which would let them
 * escalate by signing in through that group / handing the group to a confederate).
 *
 * Mirrors the role-assignment ceiling test: a custom limited role reaches the
 * route, then we prove over-ceiling create/PATCH is rejected and within-ceiling
 * is accepted.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, resolveRoleId, uniqueEmail } from "../helpers/auth";
import { resetState } from "../helpers/reset";

const uniqueSlug = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("OIDC group-mapping privilege ceiling (GHSA-wf29-rmhc-rqc9)", () => {
  beforeEach(() => resetState({ skipPdns: true }));

  it("rejects a mapping to a role that grants permissions the actor lacks globally", async () => {
    const admin = await loginAsBootstrap();
    const password = "limited-oidc-mgr-pw-123456";
    const actor = await createUser(admin, {
      email: uniqueEmail("oidc-mgr"),
      name: "Limited OIDC Manager",
      password,
    });

    // A custom role that reaches the OIDC route (oidc.manage) but is far short
    // of SuperAdmin. Bootstrap is SuperAdmin so creating + granting it is allowed.
    const limitedSlug = uniqueSlug("limited-oidc");
    await admin.sendJson("POST", "/api/admin/roles", {
      slug: limitedSlug,
      name: "Limited OIDC Manager",
      permissions: ["auth.manage", "auth.read", "zone.read"],
    });
    const limitedRoleId = await resolveRoleId(admin, limitedSlug);
    await admin.sendJson("POST", `/api/admin/users/${actor.id}/role-assignments`, {
      roleId: limitedRoleId,
      scopeType: "global",
    });

    // A within-ceiling target role (permissions ⊆ actor's global set).
    const withinSlug = uniqueSlug("within-ceiling");
    await admin.sendJson("POST", "/api/admin/roles", {
      slug: withinSlug,
      name: "Within Ceiling",
      permissions: ["zone.read"],
    });

    const limited = await loginAs(actor.email, password);

    // Over the ceiling: map a group to super-admin → rejected (400 ValidationError).
    const bad = await limited.call("/api/admin/oidc-providers", {
      method: "POST",
      json: {
        slug: uniqueSlug("idp-bad"),
        name: "Bad IdP",
        issuerUrl: "https://idp.example.test",
        clientId: "id",
        clientSecret: "secret",
        groupMappings: [
          { group: "superusers", roleSlug: "super-admin", scopeType: "global", scopeId: null },
        ],
      },
    });
    expect(bad.status).toBe(400);

    // Within the ceiling: map a group to the within-ceiling role → 201.
    const ok = await limited.call("/api/admin/oidc-providers", {
      method: "POST",
      json: {
        slug: uniqueSlug("idp-ok"),
        name: "OK IdP",
        issuerUrl: "https://idp.example.test",
        clientId: "id",
        clientSecret: "secret",
        groupMappings: [
          { group: "readers", roleSlug: withinSlug, scopeType: "global", scopeId: null },
        ],
      },
    });
    expect(ok.status).toBe(201);
  });

  it("blocks the same escalation via PATCH", async () => {
    const admin = await loginAsBootstrap();
    const password = "limited-oidc-patch-pw-123456";
    const actor = await createUser(admin, {
      email: uniqueEmail("oidc-patch"),
      name: "Limited OIDC Patcher",
      password,
    });
    const limitedSlug = uniqueSlug("limited-patch");
    await admin.sendJson("POST", "/api/admin/roles", {
      slug: limitedSlug,
      name: "Limited OIDC Patcher",
      permissions: ["auth.manage", "auth.read", "zone.read"],
    });
    const limitedRoleId = await resolveRoleId(admin, limitedSlug);
    await admin.sendJson("POST", `/api/admin/users/${actor.id}/role-assignments`, {
      roleId: limitedRoleId,
      scopeType: "global",
    });

    const limited = await loginAs(actor.email, password);

    // Create a clean provider (no mappings) within the ceiling.
    const { provider } = await limited.sendJson<{ provider: { id: string } }>(
      "POST",
      "/api/admin/oidc-providers",
      {
        slug: uniqueSlug("idp-patch"),
        name: "Patch IdP",
        issuerUrl: "https://idp.example.test",
        clientId: "id",
        clientSecret: "secret",
      },
    );

    // Now try to PATCH in an over-ceiling mapping → rejected.
    const bad = await limited.call(`/api/admin/oidc-providers/${provider.id}`, {
      method: "PATCH",
      json: {
        groupMappings: [
          { group: "superusers", roleSlug: "super-admin", scopeType: "global", scopeId: null },
        ],
      },
    });
    expect(bad.status).toBe(400);
  });
});
