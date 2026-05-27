import { describe, expect, it } from "vitest";
import { detectAppUrlMismatch } from "./app-url-check";

function h(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("detectAppUrlMismatch", () => {
  it("matches when host + scheme line up exactly", () => {
    expect(
      detectAppUrlMismatch(h({ host: "dns.example.com" }), "https://dns.example.com", "https"),
    ).toEqual({
      mismatch: false,
      actualOrigin: "https://dns.example.com",
      expectedOrigin: "https://dns.example.com",
    });
  });

  it("detects the classic 'copied localhost from .env.example' case", () => {
    // Operator accessed http://192.168.1.10:3000 but APP_URL is localhost:3000.
    const result = detectAppUrlMismatch(
      h({ host: "192.168.1.10:3000" }),
      "http://localhost:3000",
      "http",
    );
    expect(result).toEqual({
      mismatch: true,
      actualOrigin: "http://192.168.1.10:3000",
      expectedOrigin: "http://localhost:3000",
    });
  });

  it("uses X-Forwarded-Host + X-Forwarded-Proto when present (behind a proxy)", () => {
    expect(
      detectAppUrlMismatch(
        h({
          host: "app:3000",
          "x-forwarded-host": "dns.example.com",
          "x-forwarded-proto": "https",
        }),
        "https://dns.example.com",
        "http",
      ),
    ).toEqual({
      mismatch: false,
      actualOrigin: "https://dns.example.com",
      expectedOrigin: "https://dns.example.com",
    });
  });

  it("takes only the first value from chained X-Forwarded headers", () => {
    expect(
      detectAppUrlMismatch(
        h({
          host: "app:3000",
          "x-forwarded-host": "dns.example.com, internal-lb",
          "x-forwarded-proto": "https, http",
        }),
        "https://dns.example.com",
        "http",
      )?.mismatch,
    ).toBe(false);
  });

  it("flags scheme-only mismatches (http vs https)", () => {
    expect(
      detectAppUrlMismatch(h({ host: "dns.example.com" }), "https://dns.example.com", "http")
        ?.mismatch,
    ).toBe(true);
  });

  it("flags port-only mismatches", () => {
    expect(
      detectAppUrlMismatch(h({ host: "localhost" }), "http://localhost:3000", "http")?.mismatch,
    ).toBe(true);
  });

  it("returns null when the Host header is missing (no signal, not a mismatch)", () => {
    expect(detectAppUrlMismatch(h({}), "http://localhost:3000", "http")).toBeNull();
  });

  it("returns null when APP_URL is malformed (env.ts should have already failed boot)", () => {
    expect(detectAppUrlMismatch(h({ host: "anything" }), "::not a url::", "http")).toBeNull();
  });
});
