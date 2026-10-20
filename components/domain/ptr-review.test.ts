import { describe, expect, it } from "vitest";
import { buildPtrReview, RECTIFY_DEFAULT_TTL } from "./ptr-review";

describe("buildPtrReview", () => {
  it("removes an orphan PTR RRset entirely", () => {
    const [zone, ...rest] = buildPtrReview([
      {
        owner: "1.1.20.172.in-addr.arpa.",
        reverseZone: "20.172.in-addr.arpa.",
        currentTargets: ["host.example.internal."],
        currentTtl: 10,
        action: "remove",
        target: "host.example.internal.",
      },
    ]);
    expect(rest).toHaveLength(0);
    expect(zone).toEqual({
      reverseZone: "20.172.in-addr.arpa.",
      addresses: 1,
      before: [
        {
          name: "1.1.20.172.in-addr.arpa.",
          type: "PTR",
          ttl: 10,
          records: [{ content: "host.example.internal." }],
        },
      ],
      after: [],
    });
  });

  it("keeps the other targets of a multi-target PTR on remove", () => {
    const [zone] = buildPtrReview([
      {
        owner: "5.2.0.192.in-addr.arpa.",
        reverseZone: "2.0.192.in-addr.arpa.",
        currentTargets: ["a.example.com.", "B.example.com"],
        currentTtl: 300,
        action: "remove",
        target: "b.example.com.",
      },
    ]);
    expect(zone?.after).toEqual([
      {
        name: "5.2.0.192.in-addr.arpa.",
        type: "PTR",
        ttl: 300,
        records: [{ content: "a.example.com." }],
      },
    ]);
  });

  it("writes a single target at the item's TTL, or the route default", () => {
    const zones = buildPtrReview([
      {
        owner: "7.2.0.192.in-addr.arpa.",
        reverseZone: "2.0.192.in-addr.arpa.",
        currentTargets: [],
        currentTtl: null,
        action: "set",
        target: "web.example.com.",
      },
      {
        owner: "8.100.51.198.in-addr.arpa.",
        reverseZone: "100.51.198.in-addr.arpa.",
        currentTargets: ["old.example.com."],
        currentTtl: 600,
        action: "set",
        target: "new.example.com.",
        ttl: 120,
      },
    ]);
    expect(zones.map((z) => z.reverseZone)).toEqual([
      "100.51.198.in-addr.arpa.",
      "2.0.192.in-addr.arpa.",
    ]);
    expect(zones[0]?.before[0]?.ttl).toBe(600);
    expect(zones[0]?.after[0]).toMatchObject({
      ttl: 120,
      records: [{ content: "new.example.com." }],
    });
    expect(zones[1]?.before).toEqual([]);
    expect(zones[1]?.after[0]?.ttl).toBe(RECTIFY_DEFAULT_TTL);
  });

  it("counts addresses per reverse zone", () => {
    const item = {
      reverseZone: "20.172.in-addr.arpa.",
      currentTargets: ["host.example.internal."],
      currentTtl: 10,
      action: "remove" as const,
      target: "host.example.internal.",
    };
    const [zone] = buildPtrReview([
      { ...item, owner: "1.1.20.172.in-addr.arpa." },
      { ...item, owner: "2.1.20.172.in-addr.arpa." },
    ]);
    expect(zone?.addresses).toBe(2);
    expect(zone?.before).toHaveLength(2);
  });
});
