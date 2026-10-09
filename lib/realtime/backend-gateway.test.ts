import { describe, expect, it, vi } from "vitest";
import type { PdnsServer } from "@/lib/db/schema";
import { ForbiddenError } from "@/lib/errors";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/pdns/registry", () => ({
  getPdnsClientForRow: () => ({
    getZone: () => Promise.resolve({ name: "example.com." }),
    patchZone: () => Promise.resolve(undefined),
    deleteZone: () => Promise.resolve(undefined),
    notifyZone: () => Promise.resolve(undefined),
  }),
}));
vi.mock("./backend-status", () => ({ recordBackendStatus: vi.fn() }));

const { getBackendGateway } = await import("./backend-gateway");

function server(writeMode: "auto" | "read_only"): PdnsServer {
  return { id: "s1", slug: "s1", writeMode } as unknown as PdnsServer;
}

describe("getBackendGateway write guard", () => {
  it("refuses data writes on a read-only backend but still reads and notifies", async () => {
    const gw = getBackendGateway(server("read_only"));
    await expect(gw.getZone("example.com.")).resolves.toEqual({ name: "example.com." });
    await expect(gw.notifyZone("example.com.")).resolves.toBeUndefined();
    expect(() => gw.patchZone("example.com.", { rrsets: [] })).toThrow(ForbiddenError);
    expect(() => gw.deleteZone("example.com.")).toThrow(ForbiddenError);
  });

  it("passes writes through on a writable backend", async () => {
    const gw = getBackendGateway(server("auto"));
    await expect(gw.patchZone("example.com.", { rrsets: [] })).resolves.toBeUndefined();
  });
});
