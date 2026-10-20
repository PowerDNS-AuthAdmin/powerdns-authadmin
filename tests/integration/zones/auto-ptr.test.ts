/**
 * tests/integration/zones/auto-ptr.test.ts
 *
 * Automatic PTR maintenance end to end (issue #164): the RRset PATCH, the
 * dry-run plan, the global / per-zone / per-change switches, the Reverse DNS
 * report and rectify routes, all against a real PowerDNS. Every case creates
 * its own forward zone and the reverse zone for 192.0.2.0/24 on the
 * standalone backend, then reads PowerDNS directly to see what was written.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAndLogin, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { getZone, PDNS_BY_TOPOLOGY } from "../helpers/pdns";
import { resetState } from "../helpers/reset";
import { type TestHttp } from "../helpers/http";

const NS = ["ns1.example.com.", "ns2.example.com."] as const;
const REV = "2.0.192.in-addr.arpa.";

function randomZone(): string {
  const tag = Math.random().toString(36).slice(2, 8);
  return `autoptr-${Date.now()}-${tag}.example.com.`;
}

async function createZone(admin: TestHttp, name: string): Promise<void> {
  await admin.sendJson("POST", "/api/admin/pdns/zones", {
    serverSlug: "standalone",
    name,
    kind: "Master",
    nameservers: NS,
  });
}

async function patch(admin: TestHttp, zone: string, changes: unknown[]): Promise<Response> {
  return admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`, {
    method: "PATCH",
    json: { serverSlug: "standalone", changes },
  });
}

async function plan(admin: TestHttp, zone: string, changes: unknown[]): Promise<Response> {
  return admin.call(`/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets/ptr-plan`, {
    method: "POST",
    json: { serverSlug: "standalone", changes },
  });
}

interface PdnsRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}

async function ptrAt(owner: string): Promise<PdnsRRset | undefined> {
  const z = await getZone(PDNS_BY_TOPOLOGY.standalone, REV);
  return ((z.rrsets ?? []) as PdnsRRset[]).find((r) => r.name === owner && r.type === "PTR");
}

async function standaloneId(admin: TestHttp): Promise<string> {
  const { servers } = await admin.getJson<{ servers: Array<{ id: string; slug: string }> }>(
    "/api/admin/pdns-servers",
  );
  const standalone = servers.find((s) => s.slug === "standalone");
  if (!standalone) throw new Error("standalone backend not registered");
  return standalone.id;
}

async function setGlobalAutoPtr(admin: TestHttp, on: boolean): Promise<void> {
  const res = await admin.call("/api/admin/settings", { method: "PATCH", json: { auto_ptr: on } });
  expect(res.status).toBe(200);
}

interface Outcome {
  ip: string;
  action: string;
  reason?: string;
  reverseZone: string | null;
  currentTargets?: string[];
}

describe("auto-PTR on PATCH /rrsets", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("does nothing by default, and creates / follows / removes the PTR when the change asks for it", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    await createZone(admin, REV);
    const host = `host.${zone}`;

    // Default off: a plain save leaves the reverse zone alone.
    let res = await patch(admin, zone, [
      { kind: "upsert", name: host, type: "A", ttl: 300, records: [{ content: "192.0.2.10" }] },
    ]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ptr?: unknown }).ptr).toBeUndefined();
    expect(await ptrAt(`10.${REV}`)).toBeUndefined();

    // ptr: true creates it, mirroring the TTL.
    res = await patch(admin, zone, [
      {
        kind: "upsert",
        name: host,
        type: "A",
        ttl: 600,
        records: [{ content: "192.0.2.10" }],
        ptr: true,
      },
    ]);
    expect(res.status).toBe(200);
    let body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([
      expect.objectContaining({ ip: "192.0.2.10", action: "create", reverseZone: REV }),
    ]);
    expect(await ptrAt(`10.${REV}`)).toMatchObject({ ttl: 600, records: [{ content: host }] });

    // Changing the address moves the PTR.
    res = await patch(admin, zone, [
      {
        kind: "upsert",
        name: host,
        type: "A",
        ttl: 600,
        records: [{ content: "192.0.2.11" }],
        ptr: true,
      },
    ]);
    body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr.map((o) => [o.ip, o.action])).toEqual([
      ["192.0.2.11", "create"],
      ["192.0.2.10", "delete"],
    ]);
    expect(await ptrAt(`10.${REV}`)).toBeUndefined();
    expect(await ptrAt(`11.${REV}`)).toMatchObject({ records: [{ content: host }] });

    // Deleting the RRset removes the PTR too.
    res = await patch(admin, zone, [{ kind: "delete", name: host, type: "A", ptr: true }]);
    body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([expect.objectContaining({ ip: "192.0.2.11", action: "delete" })]);
    expect(await ptrAt(`11.${REV}`)).toBeUndefined();
  }, 60_000);

  it("never overwrites a PTR that points elsewhere unless told to take it over, and never deletes it", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    await createZone(admin, REV);
    await patch(admin, REV, [
      {
        kind: "upsert",
        name: `20.${REV}`,
        type: "PTR",
        ttl: 300,
        records: [{ content: "other.example.net." }],
      },
    ]);

    let res = await patch(admin, zone, [
      {
        kind: "upsert",
        name: `a.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.20" }],
        ptr: true,
      },
    ]);
    let body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([
      expect.objectContaining({ action: "conflict", currentTargets: ["other.example.net."] }),
    ]);
    expect(await ptrAt(`20.${REV}`)).toMatchObject({
      records: [{ content: "other.example.net." }],
    });

    res = await patch(admin, zone, [
      {
        kind: "upsert",
        name: `a.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.20" }],
        ptr: true,
        ptrTakeover: true,
      },
    ]);
    body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([expect.objectContaining({ action: "update" })]);
    expect(await ptrAt(`20.${REV}`)).toMatchObject({ records: [{ content: `a.${zone}` }] });

    // Somebody re-points it; deleting our record must leave it alone.
    await patch(admin, REV, [
      {
        kind: "upsert",
        name: `20.${REV}`,
        type: "PTR",
        ttl: 300,
        records: [{ content: "third.example.net." }],
      },
    ]);
    res = await patch(admin, zone, [{ kind: "delete", name: `a.${zone}`, type: "A", ptr: true }]);
    body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([
      expect.objectContaining({ action: "unchanged", reason: "points-elsewhere" }),
    ]);
    expect(await ptrAt(`20.${REV}`)).toMatchObject({
      records: [{ content: "third.example.net." }],
    });
  }, 60_000);

  it("skips an address no hosted reverse zone covers, and the forward save still succeeds", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    const res = await patch(admin, zone, [
      {
        kind: "upsert",
        name: `far.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "203.0.113.9" }],
        ptr: true,
      },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; ptr: Outcome[] };
    expect(body.applied).toBe(1);
    expect(body.ptr).toEqual([
      expect.objectContaining({
        ip: "203.0.113.9",
        action: "skip",
        reason: "no-reverse-zone",
        reverseZone: null,
      }),
    ]);
  }, 30_000);

  it("follows the global setting and the per-zone metadata override when the change leaves ptr out", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    await createZone(admin, REV);

    await setGlobalAutoPtr(admin, true);
    try {
      let res = await patch(admin, zone, [
        {
          kind: "upsert",
          name: `g.${zone}`,
          type: "A",
          ttl: 300,
          records: [{ content: "192.0.2.30" }],
        },
      ]);
      expect(((await res.json()) as { ptr: Outcome[] }).ptr).toEqual([
        expect.objectContaining({ action: "create" }),
      ]);
      expect(await ptrAt(`30.${REV}`)).toBeDefined();

      // The zone opts out: no PTR for a new address, old one untouched.
      res = await admin.call(
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/X-AUTHADMIN-AUTO-PTR`,
        {
          method: "PUT",
          json: { serverSlug: "standalone", values: ["off"] },
        },
      );
      expect(res.status).toBe(200);
      res = await patch(admin, zone, [
        {
          kind: "upsert",
          name: `h.${zone}`,
          type: "A",
          ttl: 300,
          records: [{ content: "192.0.2.31" }],
        },
      ]);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ptr?: unknown }).ptr).toBeUndefined();
      expect(await ptrAt(`31.${REV}`)).toBeUndefined();

      // Garbage is rejected at the metadata boundary rather than stored.
      res = await admin.call(
        `/api/admin/pdns/zones/${encodeURIComponent(zone)}/metadata/X-AUTHADMIN-AUTO-PTR`,
        {
          method: "PUT",
          json: { serverSlug: "standalone", values: ["sometimes"] },
        },
      );
      expect(res.status).toBe(400);
    } finally {
      await setGlobalAutoPtr(admin, false);
    }
  }, 60_000);

  it("plans without writing, and refuses the PTR for a user without rights in the reverse zone", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    await createZone(admin, REV);

    const changes = [
      {
        kind: "upsert",
        name: `p.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.40" }],
        ptr: true,
      },
    ];
    let res = await plan(admin, zone, changes);
    expect(res.status).toBe(200);
    const planned = (await res.json()) as {
      zoneDefault: { enabled: boolean; source: string };
      ptr: Outcome[];
    };
    expect(planned.zoneDefault).toEqual({ enabled: false, source: "builtin" });
    expect(planned.ptr).toEqual([
      expect.objectContaining({ ip: "192.0.2.40", action: "create", reverseZone: REV }),
    ]);
    expect(await ptrAt(`40.${REV}`)).toBeUndefined();

    // An editor granted only on the forward zone: the forward write lands, the PTR is skipped.
    const { client: editor, user: editorUser } = await createAndLogin(admin, {
      email: uniqueEmail("ptr-editor"),
      name: "PTR editor",
      password: "ptr-editor-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    await admin.sendJson("POST", `/api/admin/users/${editorUser.id}/zone-grants`, {
      serverId: await standaloneId(admin),
      zoneName: zone,
      permissions: ["zone.read", "record.read", "record.create", "record.update", "record.delete"],
    });
    res = await patch(editor, zone, changes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ptr: Outcome[] };
    expect(body.ptr).toEqual([
      expect.objectContaining({ action: "skip", reason: "no-permission" }),
    ]);
    expect(body.ptr[0]!.currentTargets).toBeUndefined();
    expect(await ptrAt(`40.${REV}`)).toBeUndefined();
  }, 60_000);
});

describe("Reverse DNS report and rectify", () => {
  beforeEach(async () => {
    await resetState();
  });

  it("diffs forward records against PTRs and rectifies the chosen rows", async () => {
    const admin = await loginAsBootstrap();
    const zone = randomZone();
    await createZone(admin, zone);
    await createZone(admin, REV);
    await patch(admin, zone, [
      {
        kind: "upsert",
        name: `missing.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.50" }],
      },
      {
        kind: "upsert",
        name: `wrong.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.51" }],
      },
      {
        kind: "upsert",
        name: `far.${zone}`,
        type: "A",
        ttl: 300,
        records: [{ content: "203.0.113.50" }],
      },
    ]);
    await patch(admin, REV, [
      {
        kind: "upsert",
        name: `51.${REV}`,
        type: "PTR",
        ttl: 300,
        records: [{ content: "stale.example.net." }],
      },
      {
        kind: "upsert",
        name: `52.${REV}`,
        type: "PTR",
        ttl: 300,
        records: [{ content: "orphan.example.net." }],
      },
    ]);

    let res = await admin.call("/api/admin/pdns/auto-ptr/report?refresh=1", { method: "GET" });
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      rows: Array<{
        ip: string;
        status: string;
        suggestedTarget: string | null;
        currentTargets: string[];
        canWrite: boolean;
      }>;
      stats: Record<string, number>;
    };
    const byIp = Object.fromEntries(report.rows.map((r) => [r.ip, r]));
    expect(byIp["192.0.2.50"]).toMatchObject({
      status: "missing",
      suggestedTarget: `missing.${zone}`,
      canWrite: true,
    });
    expect(byIp["192.0.2.51"]).toMatchObject({
      status: "mismatch",
      currentTargets: ["stale.example.net."],
    });
    expect(byIp["192.0.2.52"]).toMatchObject({ status: "orphan", suggestedTarget: null });
    expect(byIp["203.0.113.50"]).toMatchObject({ status: "unhosted" });
    expect(report.stats).toMatchObject({ missing: 1, mismatch: 1, orphan: 1, unhosted: 1 });

    res = await admin.call("/api/admin/pdns/auto-ptr/rectify", {
      method: "POST",
      json: {
        items: [
          { ip: "192.0.2.50", action: "set", target: `missing.${zone}`, ttl: 300 },
          { ip: "192.0.2.51", action: "set", target: `wrong.${zone}`, ttl: 300 },
          { ip: "192.0.2.52", action: "remove", target: "orphan.example.net." },
        ],
      },
    });
    expect(res.status).toBe(200);
    const { outcomes } = (await res.json()) as { outcomes: Outcome[] };
    expect(outcomes.map((o) => [o.ip, o.action])).toEqual([
      ["192.0.2.50", "create"],
      ["192.0.2.51", "update"],
      ["192.0.2.52", "delete"],
    ]);
    expect(await ptrAt(`50.${REV}`)).toMatchObject({ records: [{ content: `missing.${zone}` }] });
    expect(await ptrAt(`51.${REV}`)).toMatchObject({ records: [{ content: `wrong.${zone}` }] });
    expect(await ptrAt(`52.${REV}`)).toBeUndefined();

    res = await admin.call("/api/admin/pdns/auto-ptr/report?refresh=1", { method: "GET" });
    const after = (await res.json()) as { stats: Record<string, number> };
    expect(after.stats).toMatchObject({ missing: 0, mismatch: 0, orphan: 0, ok: 2 });

    // Links for the forward zone and for the reverse zone agree with the report.
    res = await admin.call(
      `/api/admin/pdns/auto-ptr/links?zone=${encodeURIComponent(zone)}&serverSlug=standalone`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const links = (await res.json()) as {
      kind: string;
      byAddress: Record<string, { status: string; targets?: string[] }>;
    };
    expect(links.kind).toBe("forward");
    expect(links.byAddress["192.0.2.50"]).toMatchObject({
      status: "ok",
      targets: [`missing.${zone}`],
    });
    expect(links.byAddress["203.0.113.50"]).toMatchObject({ status: "unhosted" });
    res = await admin.call(
      `/api/admin/pdns/auto-ptr/links?zone=${encodeURIComponent(REV)}&serverSlug=standalone`,
      { method: "GET" },
    );
    const rev = (await res.json()) as {
      kind: string;
      byOwner: Record<string, { status: string; forward: Array<{ name: string }> }>;
    };
    expect(rev.kind).toBe("reverse");
    expect(rev.byOwner[`50.${REV}`]).toMatchObject({
      status: "ok",
      forward: [{ name: `missing.${zone}` }],
    });
  }, 90_000);

  it("requires global record.read for the report and rejects bad rectify input", async () => {
    const admin = await loginAsBootstrap();
    // Read Only holds record.read globally, so it may see the fleet diff; a user
    // with no role at all is refused.
    const { client: viewer } = await createAndLogin(admin, {
      email: uniqueEmail("ptr-viewer"),
      name: "PTR viewer",
      password: "ptr-viewer-test-pw-1234",
      roleSlug: SYSTEM_ROLES.readOnly,
    });
    const { client: nobody } = await createAndLogin(admin, {
      email: uniqueEmail("ptr-nobody"),
      name: "PTR nobody",
      password: "ptr-nobody-test-pw-1234",
    });
    expect((await nobody.call("/api/admin/pdns/auto-ptr/report", { method: "GET" })).status).toBe(
      403,
    );
    expect((await viewer.call("/api/admin/pdns/auto-ptr/report", { method: "GET" })).status).toBe(
      200,
    );
    expect(
      (
        await viewer.call("/api/admin/pdns/auto-ptr/rectify", {
          method: "POST",
          json: { items: [{ ip: "192.0.2.1", action: "set", target: "h.example.com." }] },
        })
      ).status,
    ).toBe(200);
    const bad = await admin.call("/api/admin/pdns/auto-ptr/rectify", {
      method: "POST",
      json: { items: [{ ip: "not-an-ip", action: "set", target: "host.example.com." }] },
    });
    expect(bad.status).toBe(400);
  }, 30_000);
});
