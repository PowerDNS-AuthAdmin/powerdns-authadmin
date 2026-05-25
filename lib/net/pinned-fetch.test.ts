/**
 * lib/net/pinned-fetch.test.ts
 *
 * Hermetic tests for the shared DNS-rebinding-proof fetch helper. No network:
 *   - `undici` is mocked so the per-request `Agent` ctor is captured and
 *     `fetch` is stubbed — we drive the pinned `connect.lookup` directly and
 *     assert the request options.
 *   - The guard is a plain stub; we exercise both the safe (pin + fetch) and
 *     unsafe (reject before fetch) branches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFunction } from "node:net";
import type { GuardResult } from "./pinned-fetch";

const PUBLIC_IP = "203.0.113.10"; // TEST-NET-3, globally routable
const PUBLIC_IP_6 = "2001:db8::1"; // documentation range

// Capture Agent construction + the close() call, and stub fetch so no socket
// opens. A captured `closed` flag lets us assert teardown.
const agentCtor = vi.fn();
const agentClose = vi.fn();
const fetchMock = vi.fn();

vi.mock("undici", () => {
  class FakeAgent {
    public readonly opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      agentCtor(opts);
    }
    close(): Promise<void> {
      agentClose();
      return Promise.resolve();
    }
  }
  return {
    Agent: FakeAgent,
    fetch: (...args: unknown[]) => fetchMock(...args) as unknown,
  };
});

interface CapturedLookup {
  connect?: { lookup?: LookupFunction };
}

function lookupAll(lookup: LookupFunction): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    lookup("any.host", { all: true }, (err, address) => {
      if (err) reject(err);
      else resolve(address as unknown as Array<{ address: string; family: number }>);
    });
  });
}

function lookupSingle(
  lookup: LookupFunction,
): Promise<{ address: unknown; family: number | undefined }> {
  return new Promise((resolve, reject) => {
    lookup("any.host", {}, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

describe("buildPinnedDispatcher", () => {
  beforeEach(() => {
    agentCtor.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("pins an IPv4 address in both the all:true and single lookup forms", async () => {
    const { buildPinnedDispatcher } = await import("./pinned-fetch");
    buildPinnedDispatcher([PUBLIC_IP]);

    const opts = agentCtor.mock.calls[0]?.[0] as CapturedLookup;
    const lookup = opts.connect?.lookup;
    expect(typeof lookup).toBe("function");

    expect(await lookupAll(lookup!)).toEqual([{ address: PUBLIC_IP, family: 4 }]);
    const single = await lookupSingle(lookup!);
    expect(single.address).toBe(PUBLIC_IP);
    expect(single.family).toBe(4);
  });

  it("prefers an IPv4 address when both families are present", async () => {
    const { buildPinnedDispatcher } = await import("./pinned-fetch");
    buildPinnedDispatcher([PUBLIC_IP_6, PUBLIC_IP]);
    const lookup = (agentCtor.mock.calls[0]?.[0] as CapturedLookup).connect?.lookup;
    expect(await lookupAll(lookup!)).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  it("pins the sole IPv6 address when no IPv4 is available", async () => {
    const { buildPinnedDispatcher } = await import("./pinned-fetch");
    buildPinnedDispatcher([PUBLIC_IP_6]);
    const lookup = (agentCtor.mock.calls[0]?.[0] as CapturedLookup).connect?.lookup;
    expect(await lookupAll(lookup!)).toEqual([{ address: PUBLIC_IP_6, family: 6 }]);
  });

  it("merges agentOptions but always overrides connect.lookup", async () => {
    const { buildPinnedDispatcher } = await import("./pinned-fetch");
    buildPinnedDispatcher([PUBLIC_IP], { allowH2: true, keepAliveTimeout: 1234 });
    const opts = agentCtor.mock.calls[0]?.[0] as CapturedLookup & {
      allowH2?: boolean;
      keepAliveTimeout?: number;
    };
    expect(opts.allowH2).toBe(true);
    expect(opts.keepAliveTimeout).toBe(1234);
    expect(typeof opts.connect?.lookup).toBe("function");
  });

  it("calls back with an error when there is no address to pin", async () => {
    const { buildPinnedDispatcher } = await import("./pinned-fetch");
    buildPinnedDispatcher([]);
    const lookup = (agentCtor.mock.calls[0]?.[0] as CapturedLookup).connect?.lookup;
    await expect(lookupAll(lookup!)).rejects.toThrow(/no validated address/i);
  });
});

describe("makeGuardedFetch", () => {
  beforeEach(() => {
    agentCtor.mockClear();
    agentClose.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ status: 200, ok: true });
  });
  afterEach(() => vi.clearAllMocks());

  it("pins the guard-validated address and forces redirect:error", async () => {
    const { makeGuardedFetch } = await import("./pinned-fetch");
    const guard = vi.fn(
      (): Promise<GuardResult> => Promise.resolve({ safe: true, addresses: [PUBLIC_IP] }),
    );
    const gfetch = makeGuardedFetch(guard);

    await gfetch("https://idp.example.test/.well-known/openid-configuration", {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
    });

    expect(guard).toHaveBeenCalledWith("https://idp.example.test/.well-known/openid-configuration");
    // A pinned dispatcher was built and handed to fetch.
    expect(agentCtor).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0];
    const url = fetchArgs?.[0] as string;
    const init = fetchArgs?.[1] as { redirect?: string; dispatcher?: unknown; method?: string };
    expect(url).toContain("idp.example.test");
    expect(init.method).toBe("GET"); // caller init flows through
    expect(init.redirect).toBe("error"); // forced, overriding "manual"
    expect(init.dispatcher).toBeDefined();

    // The pinned lookup returns the validated address.
    const lookup = (agentCtor.mock.calls[0]?.[0] as CapturedLookup).connect?.lookup;
    expect(await lookupAll(lookup!)).toEqual([{ address: PUBLIC_IP, family: 4 }]);

    // Dispatcher torn down after the request settles.
    await Promise.resolve();
    expect(agentClose).toHaveBeenCalledTimes(1);
  });

  it("rejects before fetching when the guard says the URL is unsafe", async () => {
    const { makeGuardedFetch } = await import("./pinned-fetch");
    const guard = vi.fn(
      (): Promise<GuardResult> => Promise.resolve({ safe: false, reason: "resolves to loopback" }),
    );
    const gfetch = makeGuardedFetch(guard);

    await expect(gfetch("https://evil.example.test")).rejects.toThrow(/unsafe URL/i);
    expect(agentCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the onUnsafe factory for the rejection error when provided", async () => {
    const { makeGuardedFetch } = await import("./pinned-fetch");
    class TransportError extends Error {}
    const guard = vi.fn(
      (): Promise<GuardResult> => Promise.resolve({ safe: false, reason: "blocked" }),
    );
    const gfetch = makeGuardedFetch(guard, {
      onUnsafe: (reason) => new TransportError(`transport: ${reason}`),
    });

    await expect(gfetch("https://evil.example.test")).rejects.toBeInstanceOf(TransportError);
    await expect(gfetch("https://evil.example.test")).rejects.toThrow(/transport: blocked/);
  });

  it("tears the dispatcher down even when the fetch itself throws", async () => {
    const { makeGuardedFetch } = await import("./pinned-fetch");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const guard = vi.fn(
      (): Promise<GuardResult> => Promise.resolve({ safe: true, addresses: [PUBLIC_IP] }),
    );
    const gfetch = makeGuardedFetch(guard);

    await expect(gfetch("https://idp.example.test")).rejects.toThrow(/ECONNREFUSED/);
    expect(agentClose).toHaveBeenCalledTimes(1);
  });

  it("accepts a URL object as input", async () => {
    const { makeGuardedFetch } = await import("./pinned-fetch");
    const guard = vi.fn(
      (): Promise<GuardResult> => Promise.resolve({ safe: true, addresses: [PUBLIC_IP] }),
    );
    const gfetch = makeGuardedFetch(guard);

    await gfetch(new URL("https://idp.example.test/path"));
    expect(guard).toHaveBeenCalledWith("https://idp.example.test/path");
  });
});
