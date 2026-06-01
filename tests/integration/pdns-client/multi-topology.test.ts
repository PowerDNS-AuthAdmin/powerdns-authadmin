/**
 * tests/integration/pdns-client/multi-topology.test.ts
 *
 * Exercises the `lib/pdns/*` client across the three PDNS deployment
 * shapes (standalone, multi-primary cluster, primary+secondaries).
 * For each: create a zone, add an RRset, verify the change is visible
 * on the right backend(s) via direct PDNS API reads.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { getZone, PDNS_BACKENDS, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { dbQuery } from "../helpers/db";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(prefix: string): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${tag}.example.com.`;
}

interface PdnsRRset {
  name: string;
  type: string;
  records: Array<{ content: string }>;
}

async function createZoneOn(
  admin: TestHttp,
  target: { serverSlug?: string; clusterSlug?: string },
  zone: string,
): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    ...target,
    name: zone,
    kind: "Master",
    nameservers: NS,
  });
}

async function patchRRset(
  admin: TestHttp,
  serverSlug: string,
  zone: string,
  rrName: string,
  ip: string,
): Promise<void> {
  await admin.sendJson("PATCH", `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    serverSlug,
    changes: [{ kind: "upsert", name: rrName, type: "A", ttl: 60, records: [{ content: ip }] }],
  });
}

describe("PDNS client behavior across topologies", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("standalone: create + patch + verify on the single backend", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("standalone");
    await createZoneOn(admin, { serverSlug: "standalone" }, zone);
    await patchRRset(admin, "standalone", zone, `www.${zone}`, "192.0.2.7");
    const z = await getZone(PDNS_BY_TOPOLOGY.standalone, zone);
    const rrset = (z.rrsets ?? []).find(
      (r: PdnsRRset) => r.name === `www.${zone}` && r.type === "A",
    );
    expect(rrset?.records?.[0]?.content).toBe("192.0.2.7");
  }, 15_000);

  it("ps-primary: create + patch + verify on the primary (secondaries may lag)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("ps");
    await createZoneOn(admin, { serverSlug: "ps-primary" }, zone);
    await patchRRset(admin, "ps-primary", zone, `www.${zone}`, "192.0.2.8");
    const z = await getZone(PDNS_BY_TOPOLOGY.psPrimary, zone);
    const rrset = (z.rrsets ?? []).find(
      (r: PdnsRRset) => r.name === `www.${zone}` && r.type === "A",
    );
    expect(rrset?.records?.[0]?.content).toBe("192.0.2.8");
  }, 15_000);

  it("multi-primary cluster: create + patch through the cluster picker; record visible on some peer", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone("cluster");
    await createZoneOn(admin, { clusterSlug: "prod-cluster" }, zone);

    // The rrsets PATCH route doesn't know about clusters - it takes a
    // concrete serverSlug. Try each peer; the one the picker chose will
    // accept the PATCH, the others will too (shared MariaDB).
    const peers = PDNS_BACKENDS.filter((b) => b.topology === "multi-primary");
    let patched = false;
    let lastStatus = 0;
    for (const p of peers) {
      const res = await admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
        method: "PATCH",
        json: {
          serverSlug: p.slug,
          changes: [
            {
              kind: "upsert",
              name: `www.${zone}`,
              type: "A",
              ttl: 60,
              records: [{ content: "192.0.2.9" }],
            },
          ],
        },
      });
      lastStatus = res.status;
      if (res.ok) {
        patched = true;
        break;
      }
    }
    expect(patched, `last status ${lastStatus}`).toBe(true);

    // Read back via any peer (shared MariaDB makes them mirror each other).
    const hits = await Promise.all(
      peers.map((p) =>
        getZone(p, zone)
          .then((z) =>
            (z.rrsets ?? []).find((r: PdnsRRset) => r.name === `www.${zone}` && r.type === "A"),
          )
          .catch(() => null),
      ),
    );
    const seen = hits.find((r) => r?.records?.[0]?.content === "192.0.2.9");
    expect(seen).toBeDefined();
  }, 20_000);

  it("cluster: zone audit entries scatter across peer slugs - history must aggregate them", async () => {
    // Root cause of the empty cluster change-history: writes route through a
    // rotating peer, so edits land under different `${peer}:${zone}` audit
    // resource_ids. Reading a single peer's slug misses the rest; the fix ORs
    // the scope across every peer. Here we edit the SAME cluster zone through
    // two peers and confirm both slugs hold audit rows.
    const admin = await loginAsBootstrap();
    const zone = randomZone("cluster-audit");
    await createZoneOn(admin, { clusterSlug: "prod-cluster" }, zone);

    await patchRRset(admin, "peer-1", zone, `a.${zone}`, "192.0.2.11");
    await patchRRset(admin, "peer-2", zone, `b.${zone}`, "192.0.2.12");

    const countFor = async (slug: string): Promise<number> => {
      const rows = await dbQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE resource_id LIKE $1`,
        [`${slug}:${zone}%`],
      );
      return Number(rows[0]?.n ?? 0);
    };

    // Each peer slug holds only its own edit (the scatter); aggregating across
    // peers is what surfaces both in the change history.
    expect(await countFor("peer-1")).toBeGreaterThan(0);
    expect(await countFor("peer-2")).toBeGreaterThan(0);
  }, 20_000);
});
