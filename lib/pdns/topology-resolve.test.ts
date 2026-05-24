import { describe, expect, it } from "vitest";
import { backendAddressSet, mastersPointAt, type Resolver } from "./topology-resolve";

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
