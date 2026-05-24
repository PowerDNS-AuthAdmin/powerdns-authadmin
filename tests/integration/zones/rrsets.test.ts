/**
 * tests/integration/zones/rrsets.test.ts
 *
 * PATCH /api/admin/pdns/zones/[zoneId]/rrsets — upsert / delete record
 * sets. Each test creates a fresh zone, applies a change via the UI's
 * API, then reads the zone back from PDNS directly to confirm the
 * resulting RRset is exactly what we asked for.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `rrsets-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

async function patchRRsets(admin: TestHttp, zone: string, changes: unknown[]): Promise<Response> {
  return admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    method: "PATCH",
    json: { serverSlug: "standalone", changes },
  });
}

interface PdnsRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string }>;
}

async function findRRset(zone: string, name: string, type: string): Promise<PdnsRRset | undefined> {
  const z = await getZone(PDNS_BY_TOPOLOGY.standalone, zone);
  const list = (z.rrsets ?? []) as PdnsRRset[];
  return list.find((r) => r.name === name && r.type === type);
}

describe("PATCH /api/admin/pdns/zones/[zoneId]/rrsets", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("upserts an A record and PDNS confirms it", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);

    const rrName = `www.${zone}`;
    const res = await patchRRsets(admin, zone, [
      { kind: "upsert", name: rrName, type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] },
    ]);
    expect(res.status).toBe(200);

    const rrset = await findRRset(zone, rrName, "A");
    expect(rrset).toBeDefined();
    expect(rrset!.records.map((r) => r.content)).toEqual(["192.0.2.1"]);
    expect(rrset!.ttl).toBe(300);
  }, 15_000);

  it("merges duplicate content in an upsert instead of failing (PDNS rejects dups)", async () => {
    // Editing one record of a multi-record RRset to a value a sibling already
    // holds yields duplicate content; PDNS would 422 with "Duplicate record in
    // RRset". The route dedupes so the edit merges to the single value.
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const rrName = `dup.${zone}`;
    const res = await patchRRsets(admin, zone, [
      {
        kind: "upsert",
        name: rrName,
        type: "A",
        ttl: 300,
        records: [{ content: "10.0.4.2" }, { content: "10.0.4.2" }],
      },
    ]);
    expect(res.status).toBe(200);
    const rrset = await findRRset(zone, rrName, "A");
    expect(rrset!.records.map((r) => r.content)).toEqual(["10.0.4.2"]);
  }, 15_000);

  it("replaces an existing A record with new content", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const rrName = `www.${zone}`;
    await patchRRsets(admin, zone, [
      { kind: "upsert", name: rrName, type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] },
    ]);
    await patchRRsets(admin, zone, [
      { kind: "upsert", name: rrName, type: "A", ttl: 300, records: [{ content: "192.0.2.99" }] },
    ]);
    const rrset = await findRRset(zone, rrName, "A");
    expect(rrset!.records.map((r) => r.content)).toEqual(["192.0.2.99"]);
  }, 15_000);

  it("deletes an RRset (changetype DELETE)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const rrName = `www.${zone}`;
    await patchRRsets(admin, zone, [
      { kind: "upsert", name: rrName, type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] },
    ]);
    const res = await patchRRsets(admin, zone, [{ kind: "delete", name: rrName, type: "A" }]);
    expect(res.status).toBe(200);
    const rrset = await findRRset(zone, rrName, "A");
    expect(rrset).toBeUndefined();
  }, 15_000);

  it("stores multiple records on a single rrset (round-robin)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const rrName = `rr.${zone}`;
    await patchRRsets(admin, zone, [
      {
        kind: "upsert",
        name: rrName,
        type: "A",
        ttl: 60,
        records: [{ content: "192.0.2.10" }, { content: "192.0.2.11" }, { content: "192.0.2.12" }],
      },
    ]);
    const rrset = await findRRset(zone, rrName, "A");
    expect(rrset!.records.map((r) => r.content).sort()).toEqual([
      "192.0.2.10",
      "192.0.2.11",
      "192.0.2.12",
    ]);
  }, 15_000);

  it("rejects malformed A content via PDNS (400)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await patchRRsets(admin, zone, [
      {
        kind: "upsert",
        name: `bad.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "not-an-ip" }],
      },
    ]);
    expect(res.status).toBe(400);
  }, 15_000);

  it("rejects an invalid type string at the validator (400)", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await patchRRsets(admin, zone, [
      {
        kind: "upsert",
        name: `foo.${zone}`,
        type: "INVALIDTYPE!!",
        ttl: 300,
        records: [{ content: "anything" }],
      },
    ]);
    expect(res.status).toBe(400);
  }, 15_000);
});
