import { describe, expect, it } from "vitest";
import { reconcilePtrs, type ForwardAddressRecord, type ReversePtrRecord } from "./ptr-reconcile";

const HOSTED = [
  { name: "2.0.192.in-addr.arpa.", server: "standalone", writable: true },
  { name: "8.b.d.0.1.0.0.2.ip6.arpa.", server: "standalone", writable: true },
  { name: "113.0.203.in-addr.arpa.", server: "mirror", writable: false },
];
const fwd = (
  name: string,
  content: string,
  extra: Partial<ForwardAddressRecord> = {},
): ForwardAddressRecord => ({
  zone: "example.com.",
  server: "standalone",
  name,
  type: content.includes(":") ? "AAAA" : "A",
  ttl: 300,
  disabled: false,
  content,
  ...extra,
});
const ptr = (
  owner: string,
  targets: string[],
  extra: Partial<ReversePtrRecord> = {},
): ReversePtrRecord => ({
  zone: "2.0.192.in-addr.arpa.",
  server: "standalone",
  owner,
  ttl: 300,
  targets,
  ...extra,
});
const run = (forward: ForwardAddressRecord[], reverse: ReversePtrRecord[], canWrite = () => true) =>
  reconcilePtrs({ forward, reverse, hostedReverseZones: HOSTED, canWriteReverse: canWrite });

describe("reconcilePtrs", () => {
  it("classifies ok, missing, mismatch, ambiguous, unhosted and orphan rows", () => {
    const { rows, stats } = run(
      [
        fwd("ok.example.com.", "192.0.2.1"),
        fwd("missing.example.com.", "192.0.2.2"),
        fwd("moved.example.com.", "192.0.2.3"),
        fwd("a.example.com.", "192.0.2.4"),
        fwd("b.example.com.", "192.0.2.4"),
        fwd("far.example.com.", "198.51.100.9"),
      ],
      [
        ptr("1.2.0.192.in-addr.arpa.", ["ok.example.com."]),
        ptr("3.2.0.192.in-addr.arpa.", ["old.example.com."]),
        ptr("9.2.0.192.in-addr.arpa.", ["gone.example.com."]),
      ],
    );
    const byIp = Object.fromEntries(rows.map((r) => [r.ip, r]));
    expect(byIp["192.0.2.1"]).toMatchObject({
      status: "ok",
      suggestedTarget: "ok.example.com.",
      canWrite: true,
    });
    expect(byIp["192.0.2.2"]).toMatchObject({
      status: "missing",
      suggestedTarget: "missing.example.com.",
      currentTargets: [],
    });
    expect(byIp["192.0.2.3"]).toMatchObject({
      status: "mismatch",
      suggestedTarget: "moved.example.com.",
      currentTargets: ["old.example.com."],
    });
    expect(byIp["192.0.2.4"]).toMatchObject({
      status: "ambiguous",
      suggestedTarget: "a.example.com.",
    });
    expect(byIp["192.0.2.4"]!.forward.map((f) => f.name)).toEqual([
      "a.example.com.",
      "b.example.com.",
    ]);
    expect(byIp["198.51.100.9"]).toMatchObject({
      status: "unhosted",
      reverseZone: null,
      suggestedTarget: null,
      canWrite: false,
    });
    expect(byIp["192.0.2.9"]).toMatchObject({
      status: "orphan",
      currentTargets: ["gone.example.com."],
      forward: [],
      suggestedTarget: null,
    });
    expect(stats).toEqual({ ok: 1, missing: 1, mismatch: 1, ambiguous: 1, orphan: 1, unhosted: 1 });
    // Worst first, then by address.
    expect(rows.map((r) => r.status)).toEqual([
      "mismatch",
      "missing",
      "ambiguous",
      "orphan",
      "unhosted",
      "ok",
    ]);
  });

  it("treats a PTR that names one of several forward names as ok, and prefers the current target when ambiguous", () => {
    const { rows } = run(
      [
        fwd("a.example.com.", "192.0.2.4"),
        fwd("b.example.com.", "192.0.2.4"),
        fwd("c.example.com.", "192.0.2.5"),
        fwd("d.example.com.", "192.0.2.5"),
      ],
      [
        ptr("4.2.0.192.in-addr.arpa.", ["B.example.com."]),
        ptr("5.2.0.192.in-addr.arpa.", ["d.example.com.", "x.example.com."]),
      ],
    );
    expect(rows.find((r) => r.ip === "192.0.2.4")).toMatchObject({ status: "ok" });
    expect(rows.find((r) => r.ip === "192.0.2.5")).toMatchObject({
      status: "ambiguous",
      suggestedTarget: "d.example.com.",
    });
  });

  it("merges IPv6 spellings and matches the reverse owner structurally", () => {
    const { rows } = run(
      [
        fwd("v6.example.com.", "2001:db8::1"),
        fwd("v6.example.com.", "2001:DB8:0:0:0:0:0:1", { zone: "other.example." }),
      ],
      [
        ptr(
          "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.",
          ["v6.example.com."],
          { zone: "8.b.d.0.1.0.0.2.ip6.arpa." },
        ),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ok", family: 6 });
    expect(rows[0]!.forward).toHaveLength(2);
  });

  it("marks rows unwritable on read-only copies or without permission, and ignores non-address PTR owners", () => {
    const { rows } = run(
      [fwd("ro.example.com.", "203.0.113.7")],
      [
        ptr("2.0.192.in-addr.arpa.", ["apex-weirdness.example.com."]),
        ptr("7.113.0.203.in-addr.arpa.", ["x."], {
          zone: "113.0.203.in-addr.arpa.",
          server: "mirror",
        }),
      ],
      () => false,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ip: "203.0.113.7",
      status: "mismatch",
      canWrite: false,
      reverseServer: "mirror",
    });
  });

  it("skips forward records whose content is not an address", () => {
    const { rows } = run([fwd("bad.example.com.", "not-an-ip")], []);
    expect(rows).toEqual([]);
  });
});
