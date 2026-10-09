/**
 * lib/pdns/http.retry.test.ts
 *
 * Retry policy of the PDNS transport, hermetic (no sockets): `undici` is
 * replaced by a scripted fetch, DNS by a constant resolver, the request-log
 * recorder by a spy.
 *
 * The property under test: a request is repeated after an ambiguous failure
 * (5xx, timeout, mid-flight transport error) ONLY when repeating is safe -
 * the request is idempotent, or the failure proves PDNS never saw it.
 * Previously every `PdnsUpstreamError` was retried regardless of method, so
 * a `POST /cryptokeys` that timed out after PDNS had committed produced two
 * KSKs, and a `POST /zones` retry surfaced as "zone already exists".
 *
 * Also covered: the per-backend lock is held for one attempt, not across the
 * backoff sleeps (another coordinated request gets its turn in between).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";

const PUBLIC_IP = "203.0.113.10";

vi.mock("node:dns", () => ({
  promises: {
    lookup: () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]),
  },
}));

const fetchMock = vi.fn();
vi.mock("undici", () => {
  class FakeAgent {
    public readonly opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
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

const recordPdnsRequest = vi.fn();
vi.mock("./request-log", () => ({
  recordPdnsRequest: (...args: unknown[]) => recordPdnsRequest(...args) as unknown,
}));

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

function response(status: number, body: unknown = { ok: true }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** What undici throws when the connect phase fails: `fetch failed` wrapping the OS error. */
function connectRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.10:8081"), {
      code: "ECONNREFUSED",
    }),
  });
}

/** A timeout after the request went out - the ambiguous case. */
function headersTimeout(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  });
}

const config = (extra: Record<string, unknown> = {}) => ({
  baseUrl: "http://pdns.example.test:8081",
  apiKey: "k",
  serverSlug: "s",
  serverDbId: "backend-1",
  maxAttempts: 3,
  ...extra,
});

describe("pdns http transport - retry policy", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    recordPdnsRequest.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not repeat a POST after a 503 - PDNS may have committed it", async () => {
    const { pdnsRequest } = await import("./http");
    const { PdnsUpstreamError } = await import("./errors");
    fetchMock.mockResolvedValueOnce(response(503, { error: "busy" }));

    await expect(
      pdnsRequest(config(), {
        method: "POST",
        path: "/api/v1/servers/localhost/zones/example.com./cryptokeys",
        op: "cryptokeys.create",
        body: { keytype: "ksk" },
      }),
    ).rejects.toBeInstanceOf(PdnsUpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a POST after a timeout once the request was on the wire", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockRejectedValueOnce(headersTimeout());

    await expect(
      pdnsRequest(config(), {
        method: "POST",
        path: "/api/v1/servers/localhost/zones",
        op: "zones.create",
        body: { name: "example.com." },
      }),
    ).rejects.toThrow(/Headers Timeout/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeats a POST when the connection was refused - PDNS never saw it", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockRejectedValueOnce(connectRefused()).mockResolvedValueOnce(response(201));

    const out = await pdnsRequest(config(), {
      method: "POST",
      path: "/api/v1/servers/localhost/zones",
      op: "zones.create",
      body: { name: "example.com." },
    });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a GET on 503 and then succeeds", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, { n: 1 }));

    const out = await pdnsRequest(config(), {
      method: "GET",
      path: "/api/v1/servers/localhost/zones",
      op: "zones.list",
    });
    expect(out).toEqual({ n: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts on a persistently failing idempotent request", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockResolvedValue(response(502));

    await expect(
      pdnsRequest(config({ maxAttempts: 3 }), {
        method: "GET",
        path: "/api/v1/servers/localhost/zones",
        op: "zones.list",
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a 4xx", async () => {
    const { pdnsRequest } = await import("./http");
    const { PdnsNotFoundError } = await import("./errors");
    fetchMock.mockResolvedValueOnce(response(404, { error: "Not Found" }));

    await expect(
      pdnsRequest(config(), {
        method: "GET",
        path: "/api/v1/servers/localhost/zones/nope.",
        op: "zones.get",
      }),
    ).rejects.toBeInstanceOf(PdnsNotFoundError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit idempotency declaration on PATCH", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(204));

    await pdnsRequest(config(), {
      method: "PATCH",
      path: "/api/v1/servers/localhost/zones/example.com.",
      op: "zones.patch",
      body: { rrsets: [] },
      idempotent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(response(503));
    await expect(
      pdnsRequest(config(), {
        method: "PATCH",
        path: "/api/v1/servers/localhost/zones/example.com.",
        op: "zones.patch",
        body: { rrsets: [] },
        idempotent: false,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the backend lock between attempts so other writers are not queued behind the backoff", async () => {
    const { pdnsRequest } = await import("./http");
    const order: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/a")) {
        order.push("a");
        // First attempt of A fails; the second succeeds.
        return Promise.resolve(
          order.filter((x) => x === "a").length === 1 ? response(503) : response(200),
        );
      }
      order.push("b");
      return Promise.resolve(response(200));
    });

    // A is the poller's probe client: its reads take the lock too.
    const a = pdnsRequest(config({ coordinateAllRequests: true }), {
      method: "GET",
      path: "/a",
      op: "a",
    });
    // Let A take the lock and fail its first attempt before B queues.
    await new Promise((r) => setTimeout(r, 5));
    const b = pdnsRequest(config(), { method: "PUT", path: "/b", op: "b", body: {} });
    await Promise.all([a, b]);

    // B ran while A was sleeping between attempts - the lock was free.
    expect(order).toEqual(["a", "b", "a"]);
  });

  it("logs the real upstream status on success (201/204 are not reported as 200)", async () => {
    const { pdnsRequest } = await import("./http");
    fetchMock.mockResolvedValueOnce(response(204));
    const out = await pdnsRequest(config(), {
      method: "DELETE",
      path: "/api/v1/servers/localhost/zones/example.com.",
      op: "zones.delete",
    });
    expect(out).toBeUndefined();
    // The audit recorder received the real status as well.
    expect(recordPdnsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ responseStatus: 204 }),
    );
  });
});
