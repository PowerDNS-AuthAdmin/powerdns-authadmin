import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "./captcha";

function mockFetchOk(body: unknown): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function mockFetchStatus(status: number): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response("", { status })));
}

function mockFetchThrows(): typeof fetch {
  return vi.fn(() => Promise.reject(new Error("network down")));
}

describe("verifyTurnstile", () => {
  it("returns ok when siteverify says success", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchOk({ success: true }),
    });
    expect(res.ok).toBe(true);
  });

  it("returns the error-codes from siteverify when not ok", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchOk({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    });
    expect(res).toEqual({
      ok: false,
      reasons: ["invalid-input-response"],
    });
  });

  it("returns verification-failed when siteverify omits error-codes", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchOk({ success: false }),
    });
    expect(res).toEqual({ ok: false, reasons: ["verification-failed"] });
  });

  it("returns transport-error on fetch throw", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchThrows(),
    });
    expect(res).toEqual({ ok: false, reasons: ["transport-error"] });
  });

  it("returns http-<status> on non-2xx response", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchStatus(503),
    });
    expect(res).toEqual({ ok: false, reasons: ["http-503"] });
  });

  it("short-circuits when token is missing", async () => {
    const f = vi.fn();
    const res = await verifyTurnstile({
      secret: "secret",
      token: "",
      fetchImpl: f,
    });
    expect(res).toEqual({ ok: false, reasons: ["missing-input-response"] });
    expect(f).not.toHaveBeenCalled();
  });

  it("includes the remoteip when provided", async () => {
    const fetchImpl = vi.fn((_url: unknown, _init: { body: URLSearchParams }) =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await verifyTurnstile({
      secret: "secret",
      token: "t",
      remoteIp: "1.2.3.4",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0]!;
    const body = call[1].body;
    expect(body.get("remoteip")).toBe("1.2.3.4");
    expect(body.get("secret")).toBe("secret");
    expect(body.get("response")).toBe("t");
  });

  it("returns malformed-response when JSON lacks a success field", async () => {
    const res = await verifyTurnstile({
      secret: "secret",
      token: "t",
      fetchImpl: mockFetchOk({ challenge_ts: "2026-05-17T00:00:00Z" }),
    });
    expect(res).toEqual({ ok: false, reasons: ["malformed-response"] });
  });
});
