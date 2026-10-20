/**
 * The orchestrator with every I/O seam faked: backend listing, zone listing,
 * PTR reads, the PATCH, audit rows and the realtime hook. Exercises the
 * decisions the pure planner cannot see - which backend hosts the reverse
 * zone, read-only copies, the caller's permission in the reverse zone, the
 * dry run, write failures and the audit rows that tie it all together.
 */
import { describe, expect, it, vi } from "vitest";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsClient } from "@/lib/pdns/client";
import { runAutoPtr, type AutoPtrDeps, type AutoPtrRequest } from "./_auto-ptr";

interface Rrset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
  comments?: unknown[];
}

function server(slug: string, extra: Partial<PdnsServer> = {}): PdnsServer {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    writeMode: "auto",
    clusterId: null,
    disabledAt: null,
    ...extra,
  } as PdnsServer;
}

interface FakeBackend {
  server: PdnsServer;
  zones: Array<{ name: string; kind: string }>;
  rrsets: Rrset[];
  patches: Array<{ zone: string; body: unknown }>;
  failPatch?: string;
  failRead?: boolean;
}

function fakeClient(b: FakeBackend): PdnsClient {
  return {
    supports: () => false,
    listZones: () =>
      Promise.resolve(b.zones.map((z) => ({ id: z.name, name: z.name, kind: z.kind }))),
    getZone: (zone: string) => {
      if (b.failRead) return Promise.reject(new Error("boom"));
      const z = b.zones.find((x) => x.name === zone);
      if (!z) return Promise.reject(new Error(`no zone ${zone}`));
      return Promise.resolve({
        id: zone,
        name: zone,
        kind: z.kind,
        rrsets: b.rrsets.filter((r) => r.name.endsWith(zone)),
      });
    },
    patchZone: (zone: string, body: unknown) => {
      if (b.failPatch === zone) return Promise.reject(new Error("PDNS said no"));
      b.patches.push({ zone, body });
      return Promise.resolve();
    },
    notifyZone: () => Promise.resolve(),
  } as unknown as PdnsClient;
}

function deps(backends: FakeBackend[]): AutoPtrDeps & { audits: unknown[]; writes: string[] } {
  const audits: unknown[] = [];
  const writes: string[] = [];
  return {
    audits,
    writes,
    listBackends: () => Promise.resolve(backends.map((b) => b.server)),
    clientFor: (s) => fakeClient(backends.find((b) => b.server.id === s.id)!),
    cachedZones: () => null,
    audit: vi.fn((row: unknown) => {
      audits.push(row);
      return Promise.resolve();
    }),
    afterWrite: (zone, slug) => writes.push(`${slug}:${zone}`),
  };
}

const REV = "2.0.192.in-addr.arpa.";
const FWD = server("primary");

function request(overrides: Partial<AutoPtrRequest> = {}): AutoPtrRequest {
  return {
    forwardServer: FWD,
    forwardZone: "example.com.",
    changes: [
      {
        change: {
          kind: "upsert",
          name: "host.example.com.",
          type: "A",
          ttl: 300,
          records: [{ content: "192.0.2.1" }],
        },
        before: null,
        takeover: false,
      },
    ],
    canOnZone: () => true,
    dryRun: false,
    actor: { type: "user", id: "u1" },
    request: { ip: null, userAgent: null, requestId: "req-1" },
    ...overrides,
  };
}

describe("runAutoPtr", () => {
  it("creates the PTR on the backend hosting the reverse zone and audits both the write and the summary", async () => {
    const primary: FakeBackend = {
      server: FWD,
      zones: [{ name: "example.com.", kind: "Native" }],
      rrsets: [],
      patches: [],
    };
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Master" }],
      rrsets: [],
      patches: [],
    };
    const d = deps([primary, reverse]);
    const out = await runAutoPtr(request(), d);
    expect(out).toEqual([
      expect.objectContaining({
        ip: "192.0.2.1",
        owner: `1.${REV}`,
        reverseZone: REV,
        server: "rev",
        action: "create",
      }),
    ]);
    expect(reverse.patches).toHaveLength(1);
    expect(reverse.patches[0]!.body).toEqual({
      rrsets: [
        {
          name: `1.${REV}`,
          type: "PTR",
          ttl: 300,
          changetype: "REPLACE",
          records: [{ content: "host.example.com." }],
          comments: [],
        },
      ],
    });
    expect(primary.patches).toHaveLength(0);
    expect(d.writes).toEqual([`rev:${REV}`]);
    const actions = d.audits.map((a) => a as { action: string; resource: { id: string } });
    expect(actions.map((a) => a.action)).toEqual([
      "record.create",
      "zone.notify",
      "record.ptr-sync",
    ]);
    expect(actions[0]!.resource.id).toBe(`rev:${REV}:1.${REV}|PTR`);
    expect(actions[2]!.resource.id).toBe("primary:example.com.:host.example.com.|A");
  });

  it("prefers the forward zone's own backend when it hosts the reverse zone too", async () => {
    const both: FakeBackend = {
      server: FWD,
      zones: [
        { name: "example.com.", kind: "Native" },
        { name: REV, kind: "Native" },
      ],
      rrsets: [],
      patches: [],
    };
    const other: FakeBackend = {
      server: server("other"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [],
      patches: [],
    };
    const out = await runAutoPtr(request(), deps([other, both]));
    expect(out[0]!.server).toBe("primary");
    expect(both.patches).toHaveLength(1);
    expect(other.patches).toHaveLength(0);
  });

  it("skips a reverse zone only hosted read-only (secondary copy or read-only backend)", async () => {
    const mirror: FakeBackend = {
      server: server("mirror", { writeMode: "read_only" }),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [],
      patches: [],
    };
    const secondary: FakeBackend = {
      server: server("sec"),
      zones: [{ name: REV, kind: "Slave" }],
      rrsets: [],
      patches: [],
    };
    const out = await runAutoPtr(request(), deps([mirror, secondary]));
    expect(out[0]).toMatchObject({
      action: "skip",
      reason: "reverse-zone-not-writable",
      reverseZone: REV,
    });
    expect(mirror.patches).toHaveLength(0);
    expect(secondary.patches).toHaveLength(0);
  });

  it("skips without revealing the current target when the caller cannot write the reverse zone", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [
        { name: `1.${REV}`, type: "PTR", ttl: 300, records: [{ content: "secret.example.net." }] },
      ],
      patches: [],
    };
    const d = deps([reverse]);
    const out = await runAutoPtr(
      request({ canOnZone: (serverId) => serverId !== reverse.server.id }),
      d,
    );
    expect(out[0]).toMatchObject({ action: "skip", reason: "no-permission" });
    expect(out[0]!.currentTargets).toBeUndefined();
    expect(reverse.patches).toHaveLength(0);
    expect(d.audits.map((a) => (a as { action: string }).action)).toEqual(["record.ptr-sync"]);
  });

  it("reports a conflict without writing, and takes over only when asked", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [
        {
          name: `1.${REV}`,
          type: "PTR",
          ttl: 300,
          records: [{ content: "other.example.com." }],
          comments: [{ content: "keep me" }],
        },
      ],
      patches: [],
    };
    const conflict = await runAutoPtr(request(), deps([reverse]));
    expect(conflict[0]).toMatchObject({
      action: "conflict",
      currentTargets: ["other.example.com."],
    });
    expect(reverse.patches).toHaveLength(0);

    const base = request();
    const taken = await runAutoPtr(
      { ...base, changes: [{ ...base.changes[0]!, takeover: true }] },
      deps([reverse]),
    );
    expect(taken[0]).toMatchObject({ action: "update" });
    // The existing comment survives the REPLACE.
    expect((reverse.patches[0]!.body as { rrsets: Rrset[] }).rrsets[0]!.comments).toEqual([
      { content: "keep me" },
    ]);
  });

  it("dry run reads and decides but never writes or audits", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [],
      patches: [],
    };
    const d = deps([reverse]);
    const out = await runAutoPtr(request({ dryRun: true }), d);
    expect(out[0]).toMatchObject({ action: "create" });
    expect(reverse.patches).toHaveLength(0);
    expect(d.audits).toHaveLength(0);
    expect(d.writes).toEqual([]);
  });

  it("marks a failed PATCH per address and keeps going", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [],
      patches: [],
      failPatch: REV,
    };
    const d = deps([reverse]);
    const out = await runAutoPtr(request(), d);
    expect(out[0]).toMatchObject({
      action: "failed",
      reason: "write-failed",
      message: "PDNS said no",
    });
    expect(d.audits.map((a) => (a as { action: string }).action)).toEqual(["record.ptr-sync"]);
  });

  it("marks addresses as failed when the reverse zone cannot be read", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [],
      patches: [],
      failRead: true,
    };
    const out = await runAutoPtr(request(), deps([reverse]));
    expect(out[0]).toMatchObject({ action: "failed", reason: "read-failed" });
  });

  it("deletes the PTR a removed address left behind, in a single PATCH per reverse zone", async () => {
    const reverse: FakeBackend = {
      server: server("rev"),
      zones: [{ name: REV, kind: "Native" }],
      rrsets: [
        { name: `1.${REV}`, type: "PTR", ttl: 300, records: [{ content: "host.example.com." }] },
        { name: `2.${REV}`, type: "PTR", ttl: 300, records: [{ content: "host.example.com." }] },
      ],
      patches: [],
    };
    const out = await runAutoPtr(
      request({
        changes: [
          {
            change: {
              kind: "upsert",
              name: "host.example.com.",
              type: "A",
              ttl: 300,
              records: [{ content: "192.0.2.1" }],
            },
            before: { ttl: 300, records: [{ content: "192.0.2.1" }, { content: "192.0.2.2" }] },
            takeover: false,
          },
        ],
      }),
      deps([reverse]),
    );
    expect(out.map((o) => [o.ip, o.action])).toEqual([
      ["192.0.2.1", "unchanged"],
      ["192.0.2.2", "delete"],
    ]);
    expect(reverse.patches).toHaveLength(1);
    expect(
      (reverse.patches[0]!.body as { rrsets: Array<{ name: string; changetype: string }> }).rrsets,
    ).toEqual([{ name: `2.${REV}`, type: "PTR", changetype: "DELETE" }]);
  });

  it("returns nothing when no change was given", async () => {
    const d = deps([]);
    expect(await runAutoPtr(request({ changes: [] }), d)).toEqual([]);
    expect(d.audits).toHaveLength(0);
  });
});
