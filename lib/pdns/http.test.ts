/**
 * lib/pdns/http.test.ts
 *
 * Regression test for the DNS-rebinding hardening (issue #10): the PDNS
 * transport must PIN the address its SSRF guard validated into the actual
 * connect, so undici cannot independently re-resolve the hostname to a
 * different (blocked) IP between the guard's lookup and the socket connect.
 *
 * Strategy — fully hermetic, no network:
 *   - Stub `node:dns` so the guard's resolution and a hypothetical second
 *     resolution return DIFFERENT addresses (a public IP first, a loopback IP
 *     after — the classic 0-TTL rebind).
 *   - Capture the `connect.lookup` undici is handed (via the Agent ctor) and
 *     prove it returns the FIRST (guard-validated) address — i.e. the connect
 *     is pinned and never consults DNS a second time.
 *   - A second test drives the guard to reject when the (single) current
 *     resolution lands in a blocked range, confirming the request never fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFunction } from "node:net";
import type * as EnvModule from "@/lib/env";

const PUBLIC_IP = "203.0.113.10"; // TEST-NET-3, globally routable + guard-safe
const REBIND_IP = "127.0.0.1"; // loopback — blocked unless private allowed

// A resolver that hands out a different answer on each call: the guard sees the
// safe public IP; any *later* independent lookup (what undici would do without
// pinning) would get the loopback address.
let dnsCallCount = 0;
const lookupAll = vi.fn();

vi.mock("node:dns", () => {
  const lookup = (
    _host: string,
    _opts: unknown,
  ): Promise<Array<{ address: string; family: number }>> => {
    return lookupAll(_host, _opts) as Promise<Array<{ address: string; family: number }>>;
  };
  return { promises: { lookup } };
});

// Capture what the per-request Agent is constructed with so we can invoke the
// pinned `connect.lookup` directly, and stub `fetch` so no socket is opened.
const agentCtor = vi.fn();
const fetchMock = vi.fn();

vi.mock("undici", () => {
  class FakeAgent {
    public readonly opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      agentCtor(opts);
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    Agent: FakeAgent,
    fetch: (...args: unknown[]) => fetchMock(...args) as unknown,
  };
});

// Keep the audit recorder out of the test (it transitively pulls the DB layer).
vi.mock("./request-log", () => ({ recordPdnsRequest: vi.fn() }));

// Force the permissive-private policy off so a rebind to loopback is "blocked"
// — the harder, security-relevant configuration.
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    isProduction: false,
    env: {
      ...actual.env,
      APP_PDNS_ALLOW_PRIVATE_NETWORKS: false,
      APP_PDNS_ALLOW_INSECURE_HTTP: true,
    },
  };
});

function lookupResultFor(): Array<{ address: string; family: number }> {
  dnsCallCount += 1;
  // First call (the guard) → public IP; any subsequent call → rebind to loopback.
  return dnsCallCount === 1
    ? [{ address: PUBLIC_IP, family: 4 }]
    : [{ address: REBIND_IP, family: 4 }];
}

describe("pdns http transport — DNS-rebinding pinning (issue #10)", () => {
  beforeEach(() => {
    dnsCallCount = 0;
    agentCtor.mockClear();
    fetchMock.mockReset();
    lookupAll.mockReset();
    lookupAll.mockImplementation(() => Promise.resolve(lookupResultFor()));
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pins the guard-validated address into the request's connect.lookup", async () => {
    const { pdnsRequest } = await import("./http");

    await pdnsRequest(
      { baseUrl: "http://pdns.example.test:8081", apiKey: "k", serverSlug: "s" },
      { method: "GET", path: "/api/v1/servers", op: "test.pin" },
    );

    // The guard resolved exactly once.
    expect(dnsCallCount).toBe(1);

    // undici got a per-request Agent carrying a pinned lookup.
    expect(agentCtor).toHaveBeenCalledTimes(1);
    const opts = agentCtor.mock.calls[0]?.[0] as { connect?: { lookup?: LookupFunction } };
    const lookup = opts.connect?.lookup;
    expect(typeof lookup).toBe("function");

    // Invoking the pinned lookup (what undici does at connect time) must return
    // the guard-validated PUBLIC IP — NOT trigger a fresh DNS query that would
    // hand back the rebind loopback address.
    const before = dnsCallCount;

    // Node's net.connect uses Happy Eyeballs by default, calling lookup with
    // `{ all: true }` and expecting an ARRAY of { address, family }. This is the
    // form that actually flows at connect time, so assert it returns the pinned
    // address in array shape (a single-form-only lookup would hand undici
    // `undefined` here and the real connect would fail).
    const pinnedAll = await new Promise<Array<{ address: string; family: number }>>(
      (resolve, reject) => {
        lookup!("pdns.example.test", { all: true }, (err, address) => {
          if (err) reject(err);
          else resolve(address as unknown as Array<{ address: string; family: number }>);
        });
      },
    );
    expect(pinnedAll).toEqual([{ address: PUBLIC_IP, family: 4 }]);

    // The single-address form (all:false / legacy callers) must also pin.
    const pinnedSingle = await new Promise<{ address: unknown; family: number | undefined }>(
      (resolve, reject) => {
        lookup!("pdns.example.test", {}, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address, family });
        });
      },
    );
    expect(pinnedSingle.address).toBe(PUBLIC_IP);
    expect(pinnedSingle.family).toBe(4);

    // No second resolution happened — the address is pinned, not re-fetched.
    expect(dnsCallCount).toBe(before);

    // The fetch itself targeted the original hostname (Host header / SNI stay
    // the hostname; only the connect address is pinned).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("pdns.example.test");
  });

  it("refuses the request when the current resolution lands in a blocked range", async () => {
    // Every resolution returns loopback → guard must reject before any fetch.
    lookupAll.mockImplementation(() => Promise.resolve([{ address: REBIND_IP, family: 4 }]));

    const { pdnsRequest } = await import("./http");

    await expect(
      pdnsRequest(
        { baseUrl: "http://pdns.example.test:8081", apiKey: "k", serverSlug: "s" },
        { method: "GET", path: "/api/v1/servers", op: "test.block" },
      ),
    ).rejects.toThrow(/unsafe URL/i);

    // The guard short-circuited: no Agent built, no fetch attempted.
    expect(agentCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
