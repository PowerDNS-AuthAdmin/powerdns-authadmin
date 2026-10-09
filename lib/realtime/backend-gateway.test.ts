/**
 * lib/realtime/backend-gateway.test.ts
 *
 * The gateway proxy is the one place every PDNS interaction's outcome feeds
 * the live reachability store, so its classification has to be exact: a
 * response of any kind - including a 4xx semantic rejection - proves the
 * backend is reachable; only transport/5xx is "down"; 401/403 is "auth"; and
 * an error that isn't a PDNS error says nothing about the backend at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsClient } from "@/lib/pdns/client";
import {
  PdnsAuthError,
  PdnsUnprocessableError,
  PdnsUpstreamError,
  PdnsValidationError,
} from "@/lib/pdns/errors";

const recordBackendStatus = vi.fn();
vi.mock("./backend-status", () => ({
  recordBackendStatus: (...args: unknown[]) => recordBackendStatus(...args) as unknown,
}));

interface FakeClient {
  serverSlug: string;
  supports: (c: string) => boolean;
  getZone: (name: string) => Promise<{ name: string }>;
  patchZone: (name: string, body: unknown) => Promise<void>;
}
let fake: FakeClient;
vi.mock("@/lib/pdns/registry", () => ({
  getPdnsClientForRow: () => fake as unknown as PdnsClient,
}));

const backend = { id: "backend-1", slug: "primary" } as unknown as PdnsServer;

describe("getBackendGateway", () => {
  beforeEach(() => {
    recordBackendStatus.mockReset();
    fake = {
      serverSlug: "primary",
      supports: (c) => c === "supportsTsigApi",
      getZone: (name) => Promise.resolve({ name }),
      patchZone: () => Promise.resolve(),
    };
  });

  it("records reachable after a successful call and returns the result unchanged", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    const client = getBackendGateway(backend);
    await expect(client.getZone("example.com.")).resolves.toEqual({ name: "example.com." });
    expect(recordBackendStatus).toHaveBeenCalledWith("backend-1", true, false);
  });

  it("records reachable on a 4xx semantic rejection (the daemon answered) and rethrows it", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    for (const err of [
      new PdnsUnprocessableError("Duplicate record", { status: 422 }),
      new PdnsValidationError("bad", { status: 400 }),
    ]) {
      recordBackendStatus.mockReset();
      fake.patchZone = () => Promise.reject(err);
      await expect(
        getBackendGateway(backend).patchZone("example.com.", { rrsets: [] }),
      ).rejects.toBe(err);
      expect(recordBackendStatus).toHaveBeenCalledWith("backend-1", true, false);
    }
  });

  it("records an auth failure on 401/403", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    fake.getZone = () => Promise.reject(new PdnsAuthError("nope", { status: 401 }));
    await expect(getBackendGateway(backend).getZone("x.")).rejects.toBeInstanceOf(PdnsAuthError);
    expect(recordBackendStatus).toHaveBeenCalledWith("backend-1", false, true);
  });

  it("records down on a transport or 5xx failure", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    fake.getZone = () => Promise.reject(new PdnsUpstreamError("timeout", { status: 0 }));
    await expect(getBackendGateway(backend).getZone("x.")).rejects.toBeInstanceOf(
      PdnsUpstreamError,
    );
    expect(recordBackendStatus).toHaveBeenCalledWith("backend-1", false, false);
  });

  it("leaves the status untouched on a non-PDNS error", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    fake.getZone = () => Promise.reject(new TypeError("schema mismatch"));
    await expect(getBackendGateway(backend).getZone("x.")).rejects.toBeInstanceOf(TypeError);
    expect(recordBackendStatus).not.toHaveBeenCalled();
  });

  it("passes sync members and getters through without recording anything", async () => {
    const { getBackendGateway } = await import("./backend-gateway");
    const client = getBackendGateway(backend);
    expect(client.serverSlug).toBe("primary");
    expect(client.supports("supportsTsigApi")).toBe(true);
    expect(recordBackendStatus).not.toHaveBeenCalled();
  });
});
