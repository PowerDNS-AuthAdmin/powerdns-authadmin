import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdnsServer } from "@/lib/db/schema";
import { listEligibleTsigKeys } from "./tsig-eligibility";

const mocks = vi.hoisted(() => ({
  clients: new Map<
    string,
    {
      listTsigKeys: ReturnType<typeof vi.fn>;
      listZones: ReturnType<typeof vi.fn>;
      getZone: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("./backend-gateway", () => ({
  getBackendGateway: (server: { id: string }) => {
    const client = mocks.clients.get(server.id);
    if (!client) throw new Error(`missing mock client for ${server.id}`);
    return client;
  },
}));

vi.mock("./tsig-replication", () => ({
  listPrimarySecondaries: vi.fn(),
}));

function server(id: string): PdnsServer {
  return { id, slug: id, name: id } as PdnsServer;
}

function client({
  keys,
  zones = [],
}: {
  keys: string[];
  zones?: Array<{ name: string; kind: string; masterTsigKeyIds?: string[] }>;
}) {
  const zoneByName = new Map(zones.map((z) => [z.name, z]));
  return {
    listTsigKeys: vi.fn(() => Promise.resolve(keys.map((name) => ({ name })))),
    listZones: vi.fn(() =>
      Promise.resolve(
        zones.map((z) => ({
          id: z.name,
          name: z.name,
          kind: z.kind,
        })),
      ),
    ),
    getZone: vi.fn((zoneName: string) => {
      const z = zoneByName.get(zoneName);
      if (!z) throw new Error(`missing zone ${zoneName}`);
      return Promise.resolve({
        id: z.name,
        name: z.name,
        kind: z.kind,
        master_tsig_key_ids: z.masterTsigKeyIds ?? [],
      });
    }),
  };
}

describe("listEligibleTsigKeys", () => {
  beforeEach(() => {
    mocks.clients.clear();
  });

  it("counts configured domains from zone details fetched without rrsets", async () => {
    const primary = server("primary");
    const secondary = server("secondary");
    const primaryClient = client({
      keys: ["shared", "primary-only"],
      zones: [
        { name: "one.example.", kind: "Master", masterTsigKeyIds: ["shared."] },
        { name: "two.example.", kind: "Primary", masterTsigKeyIds: ["other"] },
        { name: "mirror.example.", kind: "Secondary", masterTsigKeyIds: ["shared"] },
      ],
    });
    const secondaryClient = client({ keys: ["shared"] });
    mocks.clients.set(primary.id, primaryClient);
    mocks.clients.set(secondary.id, secondaryClient);

    await expect(
      listEligibleTsigKeys({
        keyHosts: [primary, secondary],
        zoneHosts: [primary],
      }),
    ).resolves.toEqual([{ name: "shared", zoneCount: 1, zones: ["one.example."] }]);

    expect(primaryClient.listZones).toHaveBeenCalledTimes(1);
    expect(primaryClient.getZone).toHaveBeenCalledTimes(2);
    expect(primaryClient.getZone).toHaveBeenCalledWith("one.example.", { rrsets: false });
    expect(primaryClient.getZone).toHaveBeenCalledWith("two.example.", { rrsets: false });
  });
});
