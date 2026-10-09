/**
 * lib/pdns/dnssec-actions.test.ts
 *
 * `ensureServedSerialAdvanced` decides whether the zone-level DNSSEC routes
 * must bump the SOA serial themselves so secondaries re-transfer the newly
 * signed (or unsigned) zone. Driven with a fake client: PowerDNS already
 * advanced the served serial (SOA-EDIT-API / a new SOA-EDIT), we patch it, or
 * there is nothing to patch; plus the RFC 1982 wrap at 0xffffffff.
 */

import { describe, expect, it, vi } from "vitest";
import type { PdnsClient } from "./client";
import type { PdnsZoneDetail } from "./types";
import { ensureServedSerialAdvanced, notifyIfTransferred } from "./dnssec-actions";

const SOA = (serial: number) =>
  `ns1.example.com. hostmaster.example.com. ${serial} 10800 3600 604800 3600`;

function zone(opts: {
  serial: number;
  editedSerial?: number;
  soa?: string | null;
}): PdnsZoneDetail {
  const rrsets =
    opts.soa === null
      ? []
      : [
          {
            name: "example.com.",
            type: "SOA",
            ttl: 3600,
            records: [{ content: opts.soa ?? SOA(opts.serial) }],
          },
        ];
  return {
    id: "example.com.",
    name: "example.com.",
    kind: "Master",
    serial: opts.serial,
    edited_serial: opts.editedSerial ?? opts.serial,
    rrsets,
  };
}

type PatchBody = Parameters<PdnsClient["patchZone"]>[1];

/** A client whose getZone answers from a queue and records every patch. */
function fakeClient(answers: PdnsZoneDetail[]) {
  const patchZone = vi.fn((_zone: string, _body: PatchBody): Promise<void> => Promise.resolve());
  const notifyZone = vi.fn((_zone: string): Promise<void> => Promise.resolve());
  const queue = [...answers];
  const getZone = vi.fn((_zone: string) =>
    Promise.resolve(queue.shift() ?? answers[answers.length - 1]!),
  );
  const client = { getZone, patchZone, notifyZone } as unknown as PdnsClient;
  return { client, getZone, patchZone, notifyZone };
}

describe("ensureServedSerialAdvanced", () => {
  it("reports 'pdns' and patches nothing when PowerDNS already moved the served serial", async () => {
    const { client, patchZone } = fakeClient([zone({ serial: 100, editedSerial: 2026100500 })]);
    const out = await ensureServedSerialAdvanced(client, "example.com.", 2026100400);
    expect(out.advance).toBe("pdns");
    expect(patchZone).not.toHaveBeenCalled();
  });

  it("bumps the SOA serial by one when the served serial did not move, then re-reads", async () => {
    const before = zone({ serial: 100 });
    const after = zone({ serial: 101 });
    const { client, patchZone, getZone } = fakeClient([before, after]);

    const out = await ensureServedSerialAdvanced(client, "example.com.", 100);

    expect(out.advance).toBe("patched");
    expect(out.zone.serial).toBe(101);
    expect(patchZone).toHaveBeenCalledTimes(1);
    expect(patchZone).toHaveBeenCalledWith("example.com.", {
      rrsets: [
        {
          name: "example.com.",
          type: "SOA",
          ttl: 3600,
          changetype: "REPLACE",
          records: [{ content: SOA(101), disabled: false }],
        },
      ],
    });
    expect(getZone).toHaveBeenCalledTimes(2);
  });

  it("treats an unknown previous serial as 'bump needed'", async () => {
    const { client, patchZone } = fakeClient([zone({ serial: 7 }), zone({ serial: 8 })]);
    const out = await ensureServedSerialAdvanced(client, "example.com.", null);
    expect(out.advance).toBe("patched");
    expect(patchZone).toHaveBeenCalledTimes(1);
  });

  it("reports 'unchanged' when the zone has no SOA to bump", async () => {
    const { client, patchZone } = fakeClient([zone({ serial: 100, soa: null })]);
    const out = await ensureServedSerialAdvanced(client, "example.com.", 100);
    expect(out.advance).toBe("unchanged");
    expect(patchZone).not.toHaveBeenCalled();
  });

  it("wraps the serial per RFC 1982 at 0xffffffff (to 1, never 0)", async () => {
    const max = 0xffffffff;
    const { client, patchZone } = fakeClient([zone({ serial: max }), zone({ serial: 1 })]);
    const out = await ensureServedSerialAdvanced(client, "example.com.", max);
    expect(out.advance).toBe("patched");
    const body = patchZone.mock.calls[0]?.[1];
    expect(body?.rrsets[0]?.records?.[0]?.content).toBe(SOA(1));
  });

  it("leaves a malformed SOA alone", async () => {
    const { client, patchZone } = fakeClient([zone({ serial: 5, soa: "garbage" })]);
    const out = await ensureServedSerialAdvanced(client, "example.com.", 5);
    expect(out.advance).toBe("unchanged");
    expect(patchZone).not.toHaveBeenCalled();
  });
});

describe("notifyIfTransferred", () => {
  it("NOTIFYs transferred kinds (incl. Producer) and skips Native/mirror kinds", async () => {
    for (const [kind, expected] of [
      ["Master", true],
      ["Primary", true],
      ["Producer", true],
      ["Native", false],
      ["Slave", false],
    ] as const) {
      const { client, notifyZone } = fakeClient([]);
      const out = await notifyIfTransferred(client, { name: "example.com.", kind }, "primary");
      expect(out).toBe(expected);
      expect(notifyZone).toHaveBeenCalledTimes(expected ? 1 : 0);
    }
  });

  it("reports false (and does not throw) when the NOTIFY fails", async () => {
    const { client, notifyZone } = fakeClient([]);
    notifyZone.mockRejectedValueOnce(new Error("boom"));
    await expect(
      notifyIfTransferred(client, { name: "example.com.", kind: "Master" }, "primary"),
    ).resolves.toBe(false);
  });
});
