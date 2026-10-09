import { describe, expect, it } from "vitest";
import {
  backendAddressSet,
  createCachingResolver,
  mastersPointAt,
  type Resolver,
} from "./topology-resolve";

describe("createCachingResolver", () => {
  it("caches a resolution for the TTL and refreshes after it", async () => {
    let clock = 1_000_000;
    let calls = 0;
    const resolve = createCachingResolver(
      () => {
        calls += 1;
        return Promise.resolve([{ address: `10.0.0.${calls}` }]);
      },
      { ttlMs: 1000, now: () => clock },
    );
    expect(await resolve("primary.example")).toEqual(["10.0.0.1"]);
    clock += 999;
    expect(await resolve("primary.example")).toEqual(["10.0.0.1"]);
    clock += 1;
    expect(await resolve("primary.example")).toEqual(["10.0.0.2"]);
    expect(calls).toBe(2);
  });

  it("evicts expired entries and bounds the map to maxEntries", async () => {
    let clock = 0;
    const resolve = createCachingResolver(() => Promise.resolve([{ address: "192.0.2.1" }]), {
      ttlMs: 100,
      maxEntries: 3,
      now: () => clock,
    });
    for (const h of ["a.example", "b.example", "c.example", "d.example", "e.example"]) {
      await resolve(h);
    }
    // Never more than maxEntries hosts, regardless of churn.
    expect(resolve.size()).toBe(3);
    clock = 1000;
    await resolve("f.example");
    // Everything older than the TTL was swept on access.
    expect(resolve.size()).toBe(1);
  });

  it("treats a lookup that exceeds the timeout as unresolvable instead of stalling", async () => {
    const resolve = createCachingResolver(
      () => new Promise(() => undefined), // never settles - a stuck resolver
      { timeoutMs: 20 },
    );
    const started = Date.now();
    expect(await resolve("stuck.example")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("caches negative results too, and passes IP literals straight through", async () => {
    let calls = 0;
    const resolve = createCachingResolver(() => {
      calls += 1;
      return Promise.reject(new Error("ENOTFOUND"));
    });
    expect(await resolve("nope.example")).toEqual([]);
    expect(await resolve("nope.example")).toEqual([]);
    expect(calls).toBe(1);
    expect(await resolve("192.0.2.7")).toEqual(["192.0.2.7"]);
    expect(await resolve("")).toEqual([]);
    expect(calls).toBe(1);
  });
});

const fakeResolver =
  (map: Record<string, string[]>): Resolver =>
  (host) =>
    Promise.resolve(map[host] ?? []);

describe("backendAddressSet", () => {
  it("includes the advertised host AND its resolved IPs", async () => {
    const set = await backendAddressSet(
      { baseUrl: "http://pdns-ps-primary:8081/api/v1", advertisedAddresses: null },
      fakeResolver({ "pdns-ps-primary": ["172.20.0.5"] }),
    );
    expect(set.has("pdns-ps-primary")).toBe(true);
    expect(set.has("172.20.0.5")).toBe(true);
  });
});

describe("mastersPointAt", () => {
  it("matches a masters[] IP against an advertised hostname's resolved IP (the docker case)", async () => {
    const resolve = fakeResolver({ "pdns-ps-primary": ["172.20.0.5"] });
    const addrSet = await backendAddressSet(
      { baseUrl: "http://pdns-ps-primary:8081/api/v1", advertisedAddresses: null },
      resolve,
    );
    // A secondary's slave zone lists the primary's container IP in masters[].
    expect(await mastersPointAt(["172.20.0.5:53"], addrSet, resolve)).toBe(true);
  });

  it("matches a direct IP advertised address", async () => {
    const r = fakeResolver({});
    const addrSet = await backendAddressSet(
      { baseUrl: "http://x:8081/api/v1", advertisedAddresses: ["192.0.2.10"] },
      r,
    );
    expect(await mastersPointAt(["192.0.2.10"], addrSet, r)).toBe(true);
  });

  it("resolves a hostname master against the address set", async () => {
    const resolve = fakeResolver({ "primary.example": ["192.0.2.10"] });
    const addrSet = await backendAddressSet(
      { baseUrl: "http://x:8081/api/v1", advertisedAddresses: ["192.0.2.10"] },
      resolve,
    );
    expect(await mastersPointAt(["primary.example"], addrSet, resolve)).toBe(true);
  });

  it("returns false for an unrelated master (external/unmanaged primary)", async () => {
    const r = fakeResolver({});
    const addrSet = await backendAddressSet(
      { baseUrl: "http://x:8081/api/v1", advertisedAddresses: ["192.0.2.10"] },
      r,
    );
    expect(await mastersPointAt(["198.51.100.9"], addrSet, r)).toBe(false);
  });
});
