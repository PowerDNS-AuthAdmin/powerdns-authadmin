import { describe, expect, it } from "vitest";
import { probeOidcDiscovery, probeFailureLabel } from "./oidc-probe";

function mockFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (_input: Parameters<typeof fetch>[0]) => {
    const next = responses[i++];
    if (next instanceof Error) return Promise.reject(next);
    if (!next) return Promise.reject(new Error("no more mock responses"));
    return Promise.resolve(next);
  };
}

const ISSUER = "https://idp.example.com";

describe("probeOidcDiscovery", () => {
  it("returns ok when the discovery doc matches the issuer URL", async () => {
    const fetch = mockFetch([new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({ ok: true, endSessionEndpoint: null });
  });

  it("treats trailing-slash issuer URLs as equivalent", async () => {
    const fetch = mockFetch([
      new Response(JSON.stringify({ issuer: `${ISSUER}/` }), { status: 200 }),
    ]);
    expect(await probeOidcDiscovery(`${ISSUER}/`, fetch)).toEqual({
      ok: true,
      endSessionEndpoint: null,
    });
    const fetch2 = mockFetch([new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })]);
    expect(await probeOidcDiscovery(`${ISSUER}/`, fetch2)).toEqual({
      ok: true,
      endSessionEndpoint: null,
    });
  });

  it("returns transport on a network error", async () => {
    const fetch = mockFetch([new Error("DNS lookup failed")]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "transport",
    });
  });

  it("returns http-status when the issuer responds non-200", async () => {
    const fetch = mockFetch([new Response("nope", { status: 503 })]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "http-status",
    });
  });

  it("returns invalid-json when the body isn't JSON", async () => {
    const fetch = mockFetch([new Response("not json", { status: 200 })]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "invalid-json",
    });
  });

  it("returns invalid-json when the body is a JSON primitive", async () => {
    const fetch = mockFetch([new Response(JSON.stringify("string"), { status: 200 })]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "invalid-json",
    });
  });

  it("returns missing-issuer when the discovery doc lacks the issuer field", async () => {
    const fetch = mockFetch([
      new Response(JSON.stringify({ authorization_endpoint: "x" }), { status: 200 }),
    ]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "missing-issuer",
    });
  });

  it("surfaces end_session_endpoint when the discovery doc advertises it", async () => {
    const endSession = "https://idp.example.com/logout";
    const fetch = mockFetch([
      new Response(JSON.stringify({ issuer: ISSUER, end_session_endpoint: endSession }), {
        status: 200,
      }),
    ]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: true,
      endSessionEndpoint: endSession,
    });
  });

  it("returns null endSessionEndpoint when missing (typed-null, never undefined)", async () => {
    const fetch = mockFetch([new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })]);
    const result = await probeOidcDiscovery(ISSUER, fetch);
    expect(result).toEqual({ ok: true, endSessionEndpoint: null });
  });

  it("returns issuer-mismatch when the doc's issuer differs", async () => {
    const fetch = mockFetch([
      new Response(JSON.stringify({ issuer: "https://attacker.example.com" }), {
        status: 200,
      }),
    ]);
    expect(await probeOidcDiscovery(ISSUER, fetch)).toEqual({
      ok: false,
      reason: "issuer-mismatch",
    });
  });
});

describe("probeFailureLabel", () => {
  it("returns a human-readable string for every reason", () => {
    expect(probeFailureLabel("transport")).toContain("reach");
    expect(probeFailureLabel("http-status")).toContain("non-200");
    expect(probeFailureLabel("invalid-json")).toContain("JSON");
    expect(probeFailureLabel("missing-issuer")).toContain("issuer");
    expect(probeFailureLabel("issuer-mismatch")).toContain("match");
  });
});
