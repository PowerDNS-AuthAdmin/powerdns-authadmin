/**
 * tests/integration/zones/horizon.test.ts
 *
 * Split-horizon zone classification (#121, ADR-0022) end-to-end: create a zone
 * as `internal`, reclassify it from the settings route, and check the row lands
 * in `zone_horizons` against the right scope - the CLUSTER for a cluster zone,
 * the SERVER for a standalone one. The scope distinction is the part unit tests
 * can't cover and the part that breaks silently (a flag stored against a
 * rotating peer appears and disappears with `choosePeer`).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type TestHttp } from "../helpers/http";
import { loginAsBootstrap } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

interface HorizonRow extends Record<string, unknown> {
  horizon: string;
  server_id: string | null;
  cluster_id: string | null;
}

async function horizonRows(zoneName: string): Promise<HorizonRow[]> {
  return dbQuery<HorizonRow>(
    "SELECT horizon, server_id, cluster_id FROM zone_horizons WHERE zone_name = $1",
    [zoneName],
  );
}

async function createZone(admin: TestHttp, body: Record<string, unknown>): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", body);
}

describe("zone horizons", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("stores an internal classification against the standalone server", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("internal");
    await createZone(admin, {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
      horizon: "internal",
    });

    const [server] = await dbQuery<{ id: string }>("SELECT id FROM pdns_servers WHERE slug = $1", [
      "standalone",
    ]);
    const rows = await horizonRows(zone);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.horizon).toBe("internal");
    expect(rows[0]?.server_id).toBe(server?.id);
    expect(rows[0]?.cluster_id).toBeNull();
  }, 15_000);

  it("writes nothing for a zone left on the default horizon", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("public");
    await createZone(admin, {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });
    // Sparse storage: `public` is the absence of a row, not a row saying public.
    expect(await horizonRows(zone)).toHaveLength(0);
  }, 15_000);

  it("classifies a cluster zone against the cluster, not the peer that served the write", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("cluster-internal");
    await createZone(admin, {
      clusterSlug: "prod-cluster",
      name: zone,
      kind: "Master",
      nameservers: NS,
      horizon: "internal",
    });

    const [cluster] = await dbQuery<{ id: string }>(
      "SELECT id FROM pdns_clusters WHERE slug = $1",
      ["prod-cluster"],
    );
    const rows = await horizonRows(zone);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cluster_id).toBe(cluster?.id);
    expect(rows[0]?.server_id).toBeNull();
  }, 20_000);

  it("reclassifies from the settings route and audits the transition", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("reclassify");
    await createZone(admin, {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
    });

    await admin.sendJson("PUT", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/settings`, {
      serverSlug: "standalone",
      horizon: "internal",
    });
    expect((await horizonRows(zone))[0]?.horizon).toBe("internal");

    // Back to public - the row is removed rather than rewritten.
    await admin.sendJson("PUT", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/settings`, {
      serverSlug: "standalone",
      horizon: "public",
    });
    expect(await horizonRows(zone)).toHaveLength(0);

    const actions = (
      await dbQuery<{ action: string }>(
        "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY ts",
        [`standalone:${zone}`],
      )
    ).map((r) => r.action);
    expect(actions.filter((a) => a === "zone.horizon.update")).toHaveLength(2);
    // A horizon-only save touches nothing on PowerDNS, so it must not log a
    // zone-settings update that updated no zone-object field.
    expect(actions).not.toContain("zone.settings.update");
  }, 20_000);

  it("drops the classification when the zone is deleted", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("del-internal");
    await createZone(admin, {
      serverSlug: "standalone",
      name: zone,
      kind: "Master",
      nameservers: NS,
      horizon: "internal",
    });
    expect(await horizonRows(zone)).toHaveLength(1);

    await admin.sendJson(
      "DELETE",
      `/api/admin/pdns/zones/${encodeURIComponent(zone)}?serverSlug=standalone`,
    );
    // Otherwise a zone recreated under the same name would silently inherit it.
    expect(await horizonRows(zone)).toHaveLength(0);
  }, 15_000);

  it("rejects an unknown horizon (400)", async () => {
    const admin = await loginAsBootstrap();
    const res = await admin.call("/api/admin/pdns/zones", {
      method: "POST",
      json: {
        serverSlug: "standalone",
        name: randomZone("bad-horizon"),
        kind: "Master",
        nameservers: NS,
        horizon: "dmz",
      },
    });
    expect(res.status).toBe(400);
  });
});
