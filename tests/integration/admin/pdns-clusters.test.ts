/**
 * tests/integration/admin/pdns-clusters.test.ts
 *
 * /api/admin/pdns/clusters — CRUD over multi-primary peer groups.
 * Cluster membership is set on the server side (server.clusterId), so
 * cluster create only carries slug/name/description/writeStrategy. Only
 * true multi-primary peer groups become cluster rows — the seeded
 * standalone primary + primary/secondary topologies are servers, not
 * clusters. The current seed includes a single multi-primary cluster
 * (prod-cluster, 3 peers).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

interface ClusterRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  writeStrategy: string;
}

const SEEDED_SLUGS = ["prod-cluster"];

function uniqueSlug(prefix = "test-cl"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("/api/admin/pdns/clusters", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists the provisioned multi-primary clusters by slug", async () => {
    const admin = await loginAsBootstrap();
    const { clusters } = await admin.getJson<{ clusters: ClusterRow[] }>(
      "/api/admin/pdns/clusters",
    );
    const slugs = clusters.map((c) => c.slug);
    for (const expected of SEEDED_SLUGS) {
      expect(slugs).toContain(expected);
    }
  });

  it("POST creates a cluster with round_robin write strategy by default", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug();
    const { cluster } = await admin.sendJson<{ cluster: ClusterRow }>(
      "POST",
      "/api/admin/pdns/clusters",
      { slug, name: "Throwaway cluster" },
    );
    expect(cluster.slug).toBe(slug);
    expect(cluster.writeStrategy).toBe("round_robin");
    await admin.sendJson("DELETE", `/api/admin/pdns/clusters/${cluster.id}`);
  });

  it("GET /[id] returns cluster + members shape", async () => {
    const admin = await loginAsBootstrap();
    const { clusters } = await admin.getJson<{ clusters: ClusterRow[] }>(
      "/api/admin/pdns/clusters",
    );
    const prod = clusters.find((c) => c.slug === "prod-cluster")!;
    const detail = await admin.getJson<{ cluster: ClusterRow; members: Array<{ slug: string }> }>(
      `/api/admin/pdns/clusters/${prod.id}`,
    );
    expect(detail.cluster.slug).toBe("prod-cluster");
    expect(Array.isArray(detail.members)).toBe(true);
    expect(detail.members.length).toBe(3);
  });

  it("PATCH updates name + writeStrategy", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("patch");
    const { cluster } = await admin.sendJson<{ cluster: ClusterRow }>(
      "POST",
      "/api/admin/pdns/clusters",
      { slug, name: "Original" },
    );
    const { cluster: updated } = await admin.sendJson<{ cluster: ClusterRow }>(
      "PATCH",
      `/api/admin/pdns/clusters/${cluster.id}`,
      { name: "Renamed", writeStrategy: "random" },
    );
    expect(updated.name).toBe("Renamed");
    expect(updated.writeStrategy).toBe("random");
    await admin.sendJson("DELETE", `/api/admin/pdns/clusters/${cluster.id}`);
  });

  it("DELETE removes an empty cluster created in this test", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("del");
    const { cluster } = await admin.sendJson<{ cluster: ClusterRow }>(
      "POST",
      "/api/admin/pdns/clusters",
      { slug, name: "ToDelete" },
    );
    await admin.sendJson("DELETE", `/api/admin/pdns/clusters/${cluster.id}`);
    const res = await admin.call(`/api/admin/pdns/clusters/${cluster.id}`);
    expect(res.status).toBe(404);
  });

  it("audit log records cluster.create on creation", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("audit");
    const { cluster } = await admin.sendJson<{ cluster: ClusterRow }>(
      "POST",
      "/api/admin/pdns/clusters",
      { slug, name: "Audited" },
    );
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY ts",
      [cluster.id],
    );
    expect(rows.map((r) => r.action)).toContain("cluster.create");
    await admin.sendJson("DELETE", `/api/admin/pdns/clusters/${cluster.id}`);
  });
});
