/**
 * components/domain/ptr-row-groups.test.ts
 *
 * Grouping must only fold rows that really are one finding: a merge of two
 * different forward sets would hide a problem behind "+ N others".
 */

import { describe, expect, it } from "vitest";
import {
  bulkActionLabel,
  compareAddresses,
  expandIpv6,
  groupPtrRows,
  groupSelectionState,
  moreLabel,
  othersLabel,
  previewList,
  ptrGroupKey,
  type GroupablePtrRow,
} from "./ptr-row-groups";

function row(overrides: Partial<GroupablePtrRow> & { ip: string }): GroupablePtrRow {
  return {
    id: overrides.ip,
    family: overrides.ip.includes(":") ? 6 : 4,
    status: "orphan",
    horizon: "internal",
    reverseZone: "20.172.in-addr.arpa.",
    reverseServer: "ns1",
    forward: [],
    currentTargets: ["host.example.internal."],
    suggestedTarget: null,
    canWrite: true,
    ...overrides,
  };
}

describe("compareAddresses", () => {
  it("orders IPv4 by octets, not as text", () => {
    const ips = ["10.42.10.1", "10.42.2.1", "10.42.1.1", "9.0.0.1"];
    expect([...ips].sort(compareAddresses)).toEqual([
      "9.0.0.1",
      "10.42.1.1",
      "10.42.2.1",
      "10.42.10.1",
    ]);
  });

  it("orders IPv6 by expanded form and puts IPv4 first", () => {
    const ips = ["2001:db8::10", "2001:db8::2", "10.0.0.1", "2001:db8:0:1::1"];
    expect([...ips].sort(compareAddresses)).toEqual([
      "10.0.0.1",
      "2001:db8::2",
      "2001:db8::10",
      "2001:db8:0:1::1",
    ]);
  });
});

describe("expandIpv6", () => {
  it("expands compressed forms and embedded IPv4", () => {
    expect(expandIpv6("2001:db8::1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(expandIpv6("::")).toBe("0000:0000:0000:0000:0000:0000:0000:0000");
    expect(expandIpv6("::ffff:192.0.2.1")).toBe("0000:0000:0000:0000:0000:ffff:c000:0201");
  });

  it("returns unparseable input lowercased", () => {
    expect(expandIpv6("not:an::ip::X")).toBe("not:an::ip::x");
  });
});

describe("groupPtrRows", () => {
  it("folds orphans with the same target, zone and server, lead sorted numerically", () => {
    const rows = ["10.42.4.1", "10.42.10.1", "10.42.2.1"].map((ip) => row({ ip }));
    const groups = groupPtrRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lead.ip).toBe("10.42.2.1");
    expect(groups[0]!.members.map((m) => m.ip)).toEqual([
      "10.42.2.1",
      "10.42.4.1",
      "10.42.10.1",
    ]);
    expect(groups[0]!.id.startsWith("group:")).toBe(true);
  });

  it("keeps a lone groupable row as a plain row with its own id", () => {
    const groups = groupPtrRows([
      row({ ip: "10.42.1.1" }),
      row({ ip: "10.42.2.1", currentTargets: ["other."] }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["10.42.1.1", "10.42.2.1"]);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });

  it("splits on horizon, reverse zone, server and write permission", () => {
    const groups = groupPtrRows([
      row({ ip: "10.42.1.1" }),
      row({ ip: "10.42.2.1", horizon: "public" }),
      row({ ip: "10.42.3.1", reverseZone: "other.in-addr.arpa." }),
      row({ ip: "10.42.4.1", reverseServer: "ns2" }),
      row({ ip: "10.42.5.1", canWrite: false }),
    ]);
    expect(groups).toHaveLength(5);
  });

  it("treats target order and case as the same finding", () => {
    const groups = groupPtrRows([
      row({ ip: "10.42.1.1", currentTargets: ["A.example.", "b.example."] }),
      row({ ip: "10.42.2.1", currentTargets: ["b.example.", "a.example."] }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("folds mismatches only with the same wrong target, forward names and fix", () => {
    const base = {
      status: "mismatch",
      currentTargets: ["old.example."],
      forward: [{ name: "new.example." }],
      suggestedTarget: "new.example.",
    };
    const groups = groupPtrRows([
      row({ ip: "10.0.0.1", ...base }),
      row({ ip: "10.0.0.2", ...base }),
      row({ ip: "10.0.0.3", ...base, suggestedTarget: "else.example." }),
      row({ ip: "10.0.0.4", ...base, currentTargets: ["older.example."] }),
    ]);
    expect(groups.map((g) => g.members.length)).toEqual([2, 1, 1]);
  });

  it("never merges unhosted rows with different forward sets or upstream answers", () => {
    const base = { status: "unhosted", reverseZone: null, reverseServer: null, currentTargets: [] };
    const groups = groupPtrRows([
      row({ ip: "198.51.100.1", ...base, forward: [{ name: "a.example." }] }),
      row({ ip: "198.51.100.2", ...base, forward: [{ name: "a.example." }] }),
      row({
        ip: "198.51.100.3",
        ...base,
        forward: [{ name: "a.example." }, { name: "b.example." }],
      }),
      row({
        ip: "198.51.100.4",
        ...base,
        forward: [{ name: "a.example." }],
        external: { status: "match", targets: ["a.example."] },
      }),
    ]);
    expect(groups.map((g) => g.members.map((m) => m.ip))).toEqual([
      ["198.51.100.1", "198.51.100.2"],
      ["198.51.100.3"],
      ["198.51.100.4"],
    ]);
  });

  it("never folds ok, missing or ambiguous rows, even with identical forward sets", () => {
    for (const status of ["ok", "missing", "ambiguous"]) {
      const forward = [{ name: "www.example." }];
      const rows = [
        row({ ip: "10.0.0.1", status, forward }),
        row({ ip: "10.0.0.2", status, forward }),
      ];
      expect(ptrGroupKey(rows[0]!)).toBeNull();
      expect(groupPtrRows(rows)).toHaveLength(2);
    }
  });

  it("keeps every row separate when grouping is off", () => {
    const rows = ["10.42.1.1", "10.42.2.1"].map((ip) => row({ ip }));
    expect(groupPtrRows(rows, false)).toHaveLength(2);
  });

  it("keeps groups at the position of their first row", () => {
    const groups = groupPtrRows([
      row({ ip: "10.9.9.9", status: "ok" }),
      row({ ip: "10.42.2.1" }),
      row({ ip: "10.8.8.8", status: "missing" }),
      row({ ip: "10.42.1.1" }),
    ]);
    expect(groups.map((g) => g.lead.ip)).toEqual(["10.9.9.9", "10.42.1.1", "10.8.8.8"]);
  });
});

describe("groupSelectionState", () => {
  const members = [{ id: "a" }, { id: "b" }];
  it("reports none, some and all", () => {
    expect(groupSelectionState(members, new Set())).toBe("none");
    expect(groupSelectionState(members, new Set(["a"]))).toBe("some");
    expect(groupSelectionState(members, new Set(["a", "b", "z"]))).toBe("all");
  });
});

describe("labels", () => {
  it("counts others, more and bulk actions", () => {
    expect(othersLabel(1)).toBe("+ 1 other");
    expect(othersLabel(27)).toBe("+ 27 others");
    expect(moreLabel(4)).toBe("+ 4 more");
    expect(bulkActionLabel("Remove", 1)).toBe("Remove PTR");
    expect(bulkActionLabel("Remove", 28)).toBe("Remove 28 PTRs");
    expect(bulkActionLabel("Write", 3)).toBe("Write 3 PTRs");
  });
});

describe("previewList", () => {
  it("caps at three and counts the rest", () => {
    expect(previewList([1, 2, 3])).toEqual({ shown: [1, 2, 3], hidden: 0 });
    expect(previewList([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], hidden: 2 });
  });
});
