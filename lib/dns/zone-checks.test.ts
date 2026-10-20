import { describe, expect, it } from "vitest";
import type { DelegationResult } from "./delegation";
import { evaluateZone, networkKey, worstSeverity, type ZoneProbeData } from "./zone-checks";

const SOA = {
  mname: "ns1.example.com.",
  rname: "hostmaster.example.com.",
  serial: 100,
  refresh: 3600,
  retry: 900,
  expire: 1209600,
  minimum: 3600,
};

function delegated(partial: Partial<DelegationResult> = {}): DelegationResult {
  return {
    zone: "example.com.",
    status: "delegated",
    nameservers: ["ns1.example.com.", "ns2.example.com."],
    glue: { "ns1.example.com.": ["192.0.2.1"], "ns2.example.com.": ["198.51.100.1"] },
    ds: [],
    parentServers: ["192.5.6.30"],
    path: [".", "com."],
    ...partial,
  };
}

function healthy(partial: Partial<ZoneProbeData> = {}): ZoneProbeData {
  return {
    zone: "example.com.",
    horizon: "public",
    pdns: {
      serial: 100,
      soa: SOA,
      nsNames: ["ns1.example.com.", "ns2.example.com."],
      dnskeys: [],
      glue: { "ns1.example.com.": ["192.0.2.1"], "ns2.example.com.": ["198.51.100.1"] },
    },
    delegation: delegated(),
    nameservers: [
      {
        name: "ns1.example.com.",
        addresses: ["192.0.2.1"],
        privateAddresses: [],
        probes: [
          {
            address: "192.0.2.1",
            ok: true,
            aa: true,
            rcodeName: "NOERROR",
            serial: 100,
            nsSet: ["ns1.example.com.", "ns2.example.com."],
            axfr: { result: "refused", records: 0 },
          },
        ],
      },
      {
        name: "ns2.example.com.",
        addresses: ["198.51.100.1"],
        privateAddresses: [],
        probes: [
          {
            address: "198.51.100.1",
            ok: true,
            aa: true,
            rcodeName: "NOERROR",
            serial: 100,
            nsSet: ["ns1.example.com.", "ns2.example.com."],
            axfr: { result: "refused", records: 0 },
          },
        ],
      },
    ],
    resolvers: [
      { address: "1.1.1.1", kind: "public", ok: true, rcodeName: "NOERROR", serial: 100 },
    ],
    reverse: { addresses: 4, missing: 0, mismatch: 0 },
    ...partial,
  };
}

const codes = (data: ZoneProbeData): string[] =>
  evaluateZone(data).map((f) => `${f.severity}:${f.code}`);

describe("evaluateZone", () => {
  it("is quiet for a healthy, consistent, delegated zone", () => {
    expect(evaluateZone(healthy())).toEqual([]);
    expect(worstSeverity([])).toBeNull();
  });

  it("flags delegation drift, with error when the sets are disjoint", () => {
    expect(
      codes(
        healthy({
          delegation: delegated({ nameservers: ["ns1.example.com.", "ns3.example.com."] }),
        }),
      ),
    ).toContain("warn:delegation.ns-mismatch");
    const disjoint = evaluateZone(
      healthy({ delegation: delegated({ nameservers: ["ns9.example.net."] }) }),
    );
    expect(disjoint[0]).toMatchObject({ code: "delegation.ns-mismatch", severity: "error" });
    expect(disjoint[0]!.detail).toContain("ns9.example.net.");
    expect(
      codes(healthy({ delegation: delegated({ status: "not-delegated", nameservers: [] }) })),
    ).toContain("error:delegation.missing");
    expect(
      codes(
        healthy({
          delegation: delegated({ status: "unreachable", nameservers: [], error: "timeout" }),
        }),
      ),
    ).toEqual(["info:delegation.unverified"]);
    expect(codes(healthy({ delegation: null }))).toEqual([]);
  });

  it("compares parent glue with the zone's own addresses", () => {
    const data = healthy({
      delegation: delegated({
        glue: { "ns1.example.com.": ["192.0.2.99"], "ns2.example.com.": ["198.51.100.1"] },
      }),
    });
    const f = evaluateZone(data).find((x) => x.code === "delegation.glue-mismatch");
    expect(f?.title).toContain("ns1.example.com.");
  });

  it("judges the DNSSEC chain from DS and DNSKEY", () => {
    expect(
      codes(healthy({ pdns: { ...healthy().pdns, dnskeys: [{ keyTag: 1, algorithm: 13 }] } })),
    ).toContain("warn:dnssec.ds-missing");
    expect(
      codes(
        healthy({
          delegation: delegated({
            ds: [{ keyTag: 1, algorithm: 13, digestType: 2, digest: "AB" }],
          }),
        }),
      ),
    ).toContain("error:dnssec.ds-orphan");
    expect(
      codes(
        healthy({
          delegation: delegated({
            ds: [{ keyTag: 1, algorithm: 13, digestType: 2, digest: "AB" }],
          }),
          pdns: { ...healthy().pdns, dnskeys: [{ keyTag: 2, algorithm: 13 }] },
        }),
      ),
    ).toContain("error:dnssec.ds-stale");
    expect(
      evaluateZone(
        healthy({
          delegation: delegated({
            ds: [{ keyTag: 1, algorithm: 13, digestType: 2, digest: "AB" }],
          }),
          pdns: { ...healthy().pdns, dnskeys: [{ keyTag: 1, algorithm: 13 }] },
        }),
      ),
    ).toEqual([]);
  });

  it("reports lame, unreachable, private and address-less nameservers", () => {
    const base = healthy();
    const ns = (p: Partial<ZoneProbeData["nameservers"][number]>) => ({
      ...base.nameservers[0]!,
      ...p,
    });
    expect(
      codes(
        healthy({
          nameservers: [
            ns({ probes: [{ address: "192.0.2.1", ok: true, aa: false, rcodeName: "NOERROR" }] }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toContain("error:nameserver.lame");
    expect(
      codes(
        healthy({
          nameservers: [
            ns({ probes: [{ address: "192.0.2.1", ok: true, aa: true, rcodeName: "REFUSED" }] }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toContain("error:nameserver.lame");
    expect(
      codes(
        healthy({
          nameservers: [
            ns({ probes: [{ address: "192.0.2.1", ok: false, error: "timeout" }] }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toContain("error:nameserver.unreachable");
    expect(
      codes(
        healthy({
          nameservers: [
            ns({
              addresses: ["192.0.2.1", "192.0.2.2"],
              probes: [
                { address: "192.0.2.1", ok: true, aa: true, rcodeName: "NOERROR", serial: 100 },
                { address: "192.0.2.2", ok: false, error: "timeout" },
              ],
            }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toContain("warn:nameserver.partially-unreachable");
    expect(
      codes(healthy({ nameservers: [ns({ addresses: [], probes: [] }), base.nameservers[1]!] })),
    ).toContain("error:nameserver.no-address");
    expect(
      codes(
        healthy({
          nameservers: [
            ns({ addresses: ["10.0.0.1"], privateAddresses: ["10.0.0.1"], probes: [] }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toContain("warn:nameserver.private-address");
    // Internal zones are allowed private nameservers.
    expect(
      codes(
        healthy({
          horizon: "internal",
          delegation: null,
          resolvers: [],
          nameservers: [
            ns({ addresses: ["10.0.0.1"], privateAddresses: ["10.0.0.1"], probes: [] }),
            base.nameservers[1]!,
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      codes(healthy({ nameservers: [ns({ isCname: true }), base.nameservers[1]!] })),
    ).toContain("warn:nameserver.cname");
  });

  it("notices serial and NS-set disagreement, single-nameserver zones and one-network fleets", () => {
    const base = healthy();
    const lagging = {
      ...base.nameservers[1]!,
      probes: [{ ...base.nameservers[1]!.probes[0]!, serial: 99 }],
    };
    const f = evaluateZone(healthy({ nameservers: [base.nameservers[0]!, lagging] })).find(
      (x) => x.code === "consistency.serial",
    );
    expect(f?.detail).toContain("ns2.example.com. (198.51.100.1): 99");
    const otherSet = {
      ...base.nameservers[1]!,
      probes: [{ ...base.nameservers[1]!.probes[0]!, nsSet: ["ns1.example.com."] }],
    };
    expect(codes(healthy({ nameservers: [base.nameservers[0]!, otherSet] }))).toContain(
      "warn:consistency.ns-set",
    );
    expect(
      codes(
        healthy({
          pdns: { ...base.pdns, nsNames: ["ns1.example.com."] },
          delegation: delegated({ nameservers: ["ns1.example.com."] }),
          nameservers: [base.nameservers[0]!],
        }),
      ),
    ).toContain("warn:nameserver.count");
    const sameNet = {
      ...base.nameservers[1]!,
      addresses: ["192.0.2.2"],
      probes: [{ ...base.nameservers[1]!.probes[0]!, address: "192.0.2.2" }],
    };
    expect(
      codes(
        healthy({
          nameservers: [base.nameservers[0]!, sameNet],
          delegation: delegated({ glue: {} }),
        }),
      ),
    ).toContain("info:nameserver.diversity");
    expect(networkKey("2001:db8:1:2::5")).toBe("2001:db8:1::/48");
  });

  it("checks SOA timers, MNAME and RNAME", () => {
    const base = healthy();
    const bad = evaluateZone(
      healthy({
        pdns: {
          ...base.pdns,
          soa: {
            ...SOA,
            refresh: 60,
            retry: 120,
            expire: 100,
            minimum: 172800,
            mname: "other.example.net.",
            rname: "hostmaster",
          },
        },
      }),
    );
    const byCode = Object.fromEntries(bad.map((f) => [f.code, f]));
    expect(byCode["soa.timers"]).toMatchObject({ severity: "error" });
    expect(byCode["soa.timers"]!.detail).toContain("refresh 60s");
    expect(byCode["soa.timers"]!.detail).toContain("minimum");
    expect(byCode["soa.mname"]).toBeDefined();
    expect(byCode["soa.rname"]).toBeDefined();
    expect(codes(healthy({ pdns: { ...base.pdns, soa: null } }))).toContain("error:soa.missing");
  });

  it("flags open zone transfers as an error on public zones and a warning on internal ones", () => {
    const base = healthy();
    const open = {
      ...base.nameservers[0]!,
      probes: [
        { ...base.nameservers[0]!.probes[0]!, axfr: { result: "open" as const, records: 12 } },
      ],
    };
    expect(codes(healthy({ nameservers: [open, base.nameservers[1]!] }))).toContain(
      "error:transfer.open",
    );
    expect(
      codes(
        healthy({
          horizon: "internal",
          delegation: null,
          resolvers: [],
          nameservers: [open, base.nameservers[1]!],
        }),
      ),
    ).toContain("warn:transfer.open");
  });

  it("reads the resolvers' view and the reverse-DNS tally", () => {
    expect(
      codes(
        healthy({
          resolvers: [{ address: "1.1.1.1", kind: "public", ok: true, rcodeName: "SERVFAIL" }],
        }),
      ),
    ).toContain("error:resolution.public");
    expect(
      codes(
        healthy({
          resolvers: [{ address: "1.1.1.1", kind: "public", ok: true, rcodeName: "NXDOMAIN" }],
        }),
      ),
    ).toContain("error:resolution.public");
    expect(
      codes(
        healthy({
          resolvers: [
            { address: "1.1.1.1", kind: "public", ok: true, rcodeName: "NOERROR", serial: 90 },
          ],
        }),
      ),
    ).toContain("info:resolution.public.stale");
    expect(
      codes(
        healthy({
          resolvers: [{ address: "1.1.1.1", kind: "public", ok: false, error: "timeout" }],
        }),
      ),
    ).toContain("warn:resolution.public");
    expect(codes(healthy({ reverse: { addresses: 4, missing: 1, mismatch: 1 } }))).toContain(
      "warn:reverse-dns.drift",
    );
    expect(
      worstSeverity(evaluateZone(healthy({ reverse: { addresses: 4, missing: 1, mismatch: 0 } }))),
    ).toBe("warn");
  });
});
