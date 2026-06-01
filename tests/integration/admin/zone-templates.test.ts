/**
 * tests/integration/admin/zone-templates.test.ts
 *
 * /api/admin/zone-templates - list / create / update / delete. The
 * provisioning step seeds at least one template ("standard-primary") into
 * a fresh DB, so the list endpoint is never empty after boot.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";

interface ZoneTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  soaTtl: number;
  soaRefresh: number;
  soaRetry: number;
  soaExpire: number;
  soaMinimum: number;
  nameservers: string[];
  records: Array<{ name: string; type: string; ttl: number; content: string }>;
  kind: string;
  defaultForPrimaryIds: string[];
}

function uniqueTemplateSlug(prefix = "tpl"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/zone-templates", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET list includes provisioning-seeded templates (non-empty)", async () => {
    const admin = await loginAsBootstrap();
    const { templates } = await admin.getJson<{ templates: ZoneTemplate[] }>(
      "/api/admin/zone-templates",
    );
    expect(templates.length).toBeGreaterThan(0);
  });

  it("POST creates a template with NS + SOA defaults", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueTemplateSlug("create");
    const res = await admin.call("/api/admin/zone-templates", {
      method: "POST",
      json: {
        slug,
        name: "New Template",
        soaTtl: 3600,
        soaRefresh: 3600,
        soaRetry: 900,
        soaExpire: 604800,
        soaMinimum: 3600,
        nameservers: ["ns1.example.com", "ns2.example.com"],
        records: [{ name: "@", type: "A", ttl: 3600, content: "192.0.2.1" }],
      },
    });
    expect(res.status).toBe(201);
    const { template } = (await res.json()) as { template: ZoneTemplate };
    expect(template.slug).toBe(slug);
    expect(template.nameservers).toEqual(["ns1.example.com", "ns2.example.com"]);
    expect(template.records).toHaveLength(1);
  });

  it("PATCH updates a template's name", async () => {
    const admin = await loginAsBootstrap();
    const { template } = await admin.sendJson<{ template: ZoneTemplate }>(
      "POST",
      "/api/admin/zone-templates",
      {
        slug: uniqueTemplateSlug("patch"),
        name: "Before",
        nameservers: ["ns1.example.com"],
      },
    );
    const updated = await admin.sendJson<{ template: ZoneTemplate }>(
      "PATCH",
      `/api/admin/zone-templates/${template.id}`,
      { name: "After" },
    );
    expect(updated.template.name).toBe("After");
  });

  it("DELETE removes a non-default template", async () => {
    const admin = await loginAsBootstrap();
    const { template } = await admin.sendJson<{ template: ZoneTemplate }>(
      "POST",
      "/api/admin/zone-templates",
      { slug: uniqueTemplateSlug("del"), name: "Doomed" },
    );
    await admin.sendJson("DELETE", `/api/admin/zone-templates/${template.id}`);
    const { templates } = await admin.getJson<{ templates: ZoneTemplate[] }>(
      "/api/admin/zone-templates",
    );
    expect(templates.find((t) => t.id === template.id)).toBeUndefined();
  });

  it("DELETE on a seeded template - route does not gate on 'default'; it succeeds", async () => {
    const admin = await loginAsBootstrap();
    const { templates: before } = await admin.getJson<{ templates: ZoneTemplate[] }>(
      "/api/admin/zone-templates",
    );
    const seeded = before[0]!;
    const res = await admin.call(`/api/admin/zone-templates/${seeded.id}`, { method: "DELETE" });
    // The route does not currently refuse deletion of seeded/default templates.
    // Tests document the existing behavior - DELETE succeeds with 200.
    expect(res.status).toBe(200);
  });

  it("GET /api/admin/zone-templates/[id] - route is not exposed; expect 404 or 405", async () => {
    const admin = await loginAsBootstrap();
    const { template } = await admin.sendJson<{ template: ZoneTemplate }>(
      "POST",
      "/api/admin/zone-templates",
      { slug: uniqueTemplateSlug("get-id"), name: "Get By Id" },
    );
    const res = await admin.call(`/api/admin/zone-templates/${template.id}`);
    expect([404, 405]).toContain(res.status);
  });
});
