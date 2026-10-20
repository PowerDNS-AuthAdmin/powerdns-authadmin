import { describe, expect, it } from "vitest";
import { candidatePtrOwners, planPtrChanges, type ExistingPtr } from "./auto-ptr";

const ZONES = ["2.0.192.in-addr.arpa.", "8.b.d.0.1.0.0.2.ip6.arpa."];
const HOST = "host.example.com.";
const OWNER_1 = "1.2.0.192.in-addr.arpa.";
const OWNER_2 = "2.2.0.192.in-addr.arpa.";

const existing = (entries: Record<string, ExistingPtr>): Map<string, ExistingPtr> =>
  new Map(Object.entries(entries));

describe("planPtrChanges: creating and updating", () => {
  it("creates a PTR for every address of a new RRset in a hosted reverse zone", () => {
    const plan = planPtrChanges(
      {
        kind: "upsert",
        name: HOST,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.1" }, { content: "192.0.2.2" }],
      },
      null,
      { hostedReverseZones: ZONES, existing: new Map() },
    );
    expect(plan.items).toEqual([
      {
        ip: "192.0.2.1",
        owner: OWNER_1,
        reverseZone: ZONES[0],
        action: "create",
        rrset: { ttl: 300, records: [{ content: HOST }] },
      },
      {
        ip: "192.0.2.2",
        owner: OWNER_2,
        reverseZone: ZONES[0],
        action: "create",
        rrset: { ttl: 300, records: [{ content: HOST }] },
      },
    ]);
  });

  it("skips addresses no hosted reverse zone covers, and says so", () => {
    const plan = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 300, records: [{ content: "203.0.113.9" }] },
      null,
      { hostedReverseZones: ZONES, existing: new Map() },
    );
    expect(plan.items).toEqual([
      {
        ip: "203.0.113.9",
        owner: "9.113.0.203.in-addr.arpa.",
        reverseZone: null,
        action: "skip",
        reason: "no-reverse-zone",
      },
    ]);
  });

  it("leaves a matching PTR alone and updates one whose TTL or disabled flag differs", () => {
    const same = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] },
      null,
      {
        hostedReverseZones: ZONES,
        existing: existing({
          [OWNER_1]: { ttl: 300, records: [{ content: "HOST.example.com." }] },
        }),
      },
    );
    expect(same.items[0]).toMatchObject({
      action: "unchanged",
      currentTargets: ["HOST.example.com."],
    });

    const ttl = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 60, records: [{ content: "192.0.2.1" }] },
      null,
      {
        hostedReverseZones: ZONES,
        existing: existing({ [OWNER_1]: { ttl: 300, records: [{ content: HOST }] } }),
      },
    );
    expect(ttl.items[0]).toMatchObject({
      action: "update",
      rrset: { ttl: 60, records: [{ content: HOST }] },
    });

    const disabled = planPtrChanges(
      {
        kind: "upsert",
        name: HOST,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.1", disabled: true }],
      },
      null,
      {
        hostedReverseZones: ZONES,
        existing: existing({ [OWNER_1]: { ttl: 300, records: [{ content: HOST }] } }),
      },
    );
    expect(disabled.items[0]).toMatchObject({
      action: "update",
      rrset: { ttl: 300, records: [{ content: HOST, disabled: true }] },
    });
  });

  it("reports a conflict when the PTR points elsewhere, and replaces it only with takeover", () => {
    const ctx = {
      hostedReverseZones: ZONES,
      existing: existing({ [OWNER_1]: { ttl: 300, records: [{ content: "other.example.com." }] } }),
    };
    const change = {
      kind: "upsert" as const,
      name: HOST,
      type: "A" as const,
      ttl: 300,
      records: [{ content: "192.0.2.1" }],
    };
    expect(planPtrChanges(change, null, ctx).items[0]).toEqual({
      ip: "192.0.2.1",
      owner: OWNER_1,
      reverseZone: ZONES[0],
      action: "conflict",
      currentTargets: ["other.example.com."],
    });
    expect(planPtrChanges(change, null, { ...ctx, takeover: true }).items[0]).toMatchObject({
      action: "update",
      currentTargets: ["other.example.com."],
      rrset: { ttl: 300, records: [{ content: HOST }] },
    });
  });

  it("treats a multi-target PTR RRset that includes us as a conflict too", () => {
    const plan = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 300, records: [{ content: "192.0.2.1" }] },
      null,
      {
        hostedReverseZones: ZONES,
        existing: existing({
          [OWNER_1]: { ttl: 300, records: [{ content: HOST }, { content: "other.example.com." }] },
        }),
      },
    );
    expect(plan.items[0]).toMatchObject({ action: "conflict" });
  });

  it("handles IPv6, comparing addresses structurally and deduplicating", () => {
    const plan = planPtrChanges(
      {
        kind: "upsert",
        name: HOST,
        type: "AAAA",
        ttl: 300,
        records: [{ content: "2001:db8::1" }, { content: "2001:DB8:0:0:0:0:0:1" }],
      },
      null,
      { hostedReverseZones: ZONES, existing: new Map() },
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "create", reverseZone: ZONES[1] });
    expect(plan.items[0]!.owner.endsWith(".8.b.d.0.1.0.0.2.ip6.arpa.")).toBe(true);
  });

  it("ignores content that is not an address", () => {
    const plan = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 300, records: [{ content: "garbage" }] },
      null,
      { hostedReverseZones: ZONES, existing: new Map() },
    );
    expect(plan.items).toEqual([]);
  });
});

describe("planPtrChanges: removing addresses", () => {
  const before = { ttl: 300, records: [{ content: "192.0.2.1" }, { content: "192.0.2.2" }] };

  it("deletes the PTRs of a deleted RRset while they still point at the name", () => {
    const plan = planPtrChanges({ kind: "delete", name: HOST, type: "A" }, before, {
      hostedReverseZones: ZONES,
      existing: existing({
        [OWNER_1]: { ttl: 300, records: [{ content: HOST }] },
        [OWNER_2]: { ttl: 300, records: [{ content: "someone-else.example.com." }] },
      }),
    });
    expect(plan.items).toEqual([
      {
        ip: "192.0.2.1",
        owner: OWNER_1,
        reverseZone: ZONES[0],
        action: "delete",
        currentTargets: [HOST],
      },
      {
        ip: "192.0.2.2",
        owner: OWNER_2,
        reverseZone: ZONES[0],
        action: "unchanged",
        reason: "points-elsewhere",
        currentTargets: ["someone-else.example.com."],
      },
    ]);
  });

  it("follows an address change: old PTR removed, new PTR created", () => {
    const plan = planPtrChanges(
      { kind: "upsert", name: HOST, type: "A", ttl: 300, records: [{ content: "192.0.2.9" }] },
      { ttl: 300, records: [{ content: "192.0.2.1" }] },
      {
        hostedReverseZones: ZONES,
        existing: existing({ [OWNER_1]: { ttl: 300, records: [{ content: HOST }] } }),
      },
    );
    expect(plan.items.map((i) => [i.ip, i.action])).toEqual([
      ["192.0.2.9", "create"],
      ["192.0.2.1", "delete"],
    ]);
  });

  it("reports an already-absent PTR as unchanged and a missing reverse zone as skipped", () => {
    const plan = planPtrChanges(
      { kind: "delete", name: HOST, type: "A" },
      { ttl: 300, records: [{ content: "192.0.2.1" }, { content: "203.0.113.1" }] },
      { hostedReverseZones: ZONES, existing: new Map() },
    );
    expect(plan.items).toEqual([
      {
        ip: "192.0.2.1",
        owner: OWNER_1,
        reverseZone: ZONES[0],
        action: "unchanged",
        reason: "already-absent",
      },
      {
        ip: "203.0.113.1",
        owner: "1.113.0.203.in-addr.arpa.",
        reverseZone: null,
        action: "skip",
        reason: "no-reverse-zone",
      },
    ]);
  });

  it("prunes only our record from a multi-target PTR RRset", () => {
    const plan = planPtrChanges(
      { kind: "delete", name: HOST, type: "A" },
      { ttl: 300, records: [{ content: "192.0.2.1" }] },
      {
        hostedReverseZones: ZONES,
        existing: existing({
          [OWNER_1]: { ttl: 120, records: [{ content: HOST }, { content: "other.example.com." }] },
        }),
      },
    );
    expect(plan.items[0]).toEqual({
      ip: "192.0.2.1",
      owner: OWNER_1,
      reverseZone: ZONES[0],
      action: "update",
      currentTargets: [HOST, "other.example.com."],
      rrset: { ttl: 120, records: [{ content: "other.example.com." }] },
    });
  });

  it("never deletes on takeover either: takeover only widens what may be replaced", () => {
    const plan = planPtrChanges(
      { kind: "delete", name: HOST, type: "A" },
      { ttl: 300, records: [{ content: "192.0.2.1" }] },
      {
        hostedReverseZones: ZONES,
        existing: existing({
          [OWNER_1]: { ttl: 300, records: [{ content: "other.example.com." }] },
        }),
        takeover: true,
      },
    );
    expect(plan.items[0]).toMatchObject({ action: "unchanged", reason: "points-elsewhere" });
  });
});

describe("candidatePtrOwners", () => {
  it("lists every owner a change could touch, with its zone", () => {
    const owners = candidatePtrOwners(
      {
        kind: "upsert",
        name: HOST,
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.9" }, { content: "203.0.113.1" }],
      },
      { records: [{ content: "192.0.2.1" }] },
      ZONES,
    );
    expect([...owners.entries()]).toEqual([
      ["9.2.0.192.in-addr.arpa.", ZONES[0]],
      [OWNER_1, ZONES[0]],
    ]);
  });
});
