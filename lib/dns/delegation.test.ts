import { describe, expect, it } from "vitest";
import { findDelegation, type DelegationQuery } from "./delegation";
import type { WireMessage, WireRecord } from "./wire";

const rr = (
  name: string,
  type: string,
  data: string,
  extra: Partial<WireRecord> = {},
): WireRecord => ({
  name,
  type,
  class: 1,
  ttl: 300,
  data,
  ...extra,
});

function msg(partial: Partial<WireMessage>): WireMessage {
  return {
    id: 1,
    rcode: 0,
    rcodeName: "NOERROR",
    aa: false,
    tc: false,
    rd: false,
    ra: false,
    ad: false,
    question: null,
    answer: [],
    authority: [],
    additional: [],
    ...partial,
  };
}

/** A scripted internet: root → com → example.com, with DS at the parent. */
function scriptedInternet(
  overrides: Partial<Record<string, (name: string, type: string) => WireMessage>> = {},
): DelegationQuery {
  const servers: Record<string, (name: string, type: string) => WireMessage> = {
    "198.41.0.4": () =>
      msg({
        authority: [
          rr("com.", "NS", "a.gtld-servers.net."),
          rr("com.", "NS", "b.gtld-servers.net."),
        ],
        additional: [
          rr("a.gtld-servers.net.", "A", "192.5.6.30"),
          rr("b.gtld-servers.net.", "A", "192.33.14.30"),
        ],
      }),
    "192.5.6.30": (name, type) =>
      type === "DS"
        ? msg({
            aa: true,
            answer: [
              rr("example.com.", "DS", "31589 8 2 ABCD", {
                ds: { keyTag: 31589, algorithm: 8, digestType: 2, digest: "ABCD" },
              }),
            ],
          })
        : name === "nope.com."
          ? msg({ rcode: 3, rcodeName: "NXDOMAIN", aa: true })
          : msg({
              authority: [
                rr("example.com.", "NS", "a.iana-servers.net."),
                rr("example.com.", "NS", "b.iana-servers.net."),
              ],
              additional: [rr("a.iana-servers.net.", "A", "199.43.135.53")],
            }),
    ...overrides,
  };
  return (name, type, server) => {
    const fn = servers[server];
    if (!fn) return Promise.reject(new Error("timeout after 3000 ms"));
    return Promise.resolve(fn(name, type));
  };
}

const lookup = (name: string): Promise<string[]> =>
  Promise.resolve(name === "b.iana-servers.net." ? ["199.43.133.53"] : []);

describe("findDelegation", () => {
  it("walks root → TLD → parent and returns the delegation, glue and DS", async () => {
    const result = await findDelegation("example.com", {
      rootServers: ["198.41.0.4"],
      query: scriptedInternet(),
      lookup,
    });
    expect(result).toMatchObject({
      zone: "example.com.",
      status: "delegated",
      nameservers: ["a.iana-servers.net.", "b.iana-servers.net."],
      glue: { "a.iana-servers.net.": ["199.43.135.53"] },
      ds: [{ keyTag: 31589, algorithm: 8 }],
      parentServers: ["192.5.6.30", "192.33.14.30"],
      path: [".", "com."],
    });
  });

  it("reports a name the parent does not know as not delegated", async () => {
    const result = await findDelegation("nope.com.", {
      rootServers: ["198.41.0.4"],
      query: scriptedInternet(),
      lookup,
    });
    expect(result.status).toBe("not-delegated");
    expect(result.path).toEqual([".", "com."]);
  });

  it("tries the next server when one times out and gives up cleanly when all do", async () => {
    const flaky = scriptedInternet({
      "192.5.6.30": () => {
        throw new Error("timeout after 3000 ms");
      },
    });
    const viaSecond = await findDelegation("example.com.", {
      rootServers: ["198.41.0.4"],
      query: (name, type, server) =>
        server === "192.33.14.30"
          ? scriptedInternet()(name, type, "192.5.6.30")
          : flaky(name, type, server),
      lookup,
    });
    expect(viaSecond.status).toBe("delegated");

    const dead = await findDelegation("example.com.", {
      rootServers: ["203.0.113.1"],
      query: scriptedInternet(),
      lookup,
    });
    expect(dead.status).toBe("unreachable");
    expect(dead.error).toContain("203.0.113.1");
  });

  it("recognises a parent that serves the zone itself instead of delegating it", async () => {
    const served = scriptedInternet({
      "192.5.6.30": () =>
        msg({ aa: true, answer: [rr("example.com.", "NS", "a.gtld-servers.net.")] }),
    });
    const result = await findDelegation("example.com.", {
      rootServers: ["198.41.0.4"],
      query: served,
      lookup,
    });
    expect(result.status).toBe("served-by-parent");
    expect(result.nameservers).toEqual(["a.gtld-servers.net."]);
  });

  it("refuses a referral that leads away from the target", async () => {
    const bogus = scriptedInternet({
      "192.5.6.30": () =>
        msg({
          authority: [rr("evil.net.", "NS", "ns.evil.net.")],
          additional: [rr("ns.evil.net.", "A", "203.0.113.9")],
        }),
    });
    const result = await findDelegation("example.com.", {
      rootServers: ["198.41.0.4"],
      query: bogus,
      lookup,
    });
    expect(result.status).toBe("not-delegated");
    expect(result.error).toContain("evil.net.");
  });
});
