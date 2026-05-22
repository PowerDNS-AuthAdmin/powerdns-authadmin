/**
 * tests/integration/helpers/http.ts
 *
 * Minimal HTTP client for the integration suite. Holds the cookie jar between
 * requests so the same session_id + pda_csrf survives a multi-request flow
 * (login → mutate → read), and copies the pda_csrf cookie into the
 * `x-csrf-token` header on mutating methods — mirroring the real
 * `lib/client/api-fetch.ts` behavior so server-side CSRF checks pass.
 *
 * Tests construct one client per "user" they want to act as. Two clients
 * have isolated cookie jars, so you can model "admin posts, operator
 * reads" without juggling cookies by hand.
 */

import { randomInt } from "node:crypto";

const TEST_APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Each TestHttp instance models one logical client (one browser / one
 * machine), so it presents a distinct source IP via `X-Forwarded-For`. The
 * app's per-IP rate limiter (login, password-reset, …) then buckets each test
 * client separately — mirroring production, where distinct users connect from
 * distinct addresses. Without this, every request in the suite collapses to a
 * single `unknown` bucket and the suite trips its own login throttle. This
 * keeps app-level rate limiting fully ACTIVE under test rather than disabling
 * it. The app always honors forwarded headers (no TRUST_PROXY toggle), and the
 * test stack has no proxy in front to strip them.
 *
 * The IP is RANDOM (not a sequential counter): vitest isolates each test file,
 * so a module-level counter resets per file and low IPs (10.0.0.1, …) would
 * collide ACROSS files onto the same per-IP bucket in the long-lived app
 * process and exhaust it. A random address in 10.0.0.0/8 (~16.7M) makes a
 * collision between the suite's few-hundred clients negligible, regardless of
 * how vitest forks.
 */
function nextTestClientIp(): string {
  const oct = (): number => randomInt(256);
  return `10.${oct()}.${oct()}.${randomInt(1, 256)}`;
}

export interface CallInit extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit | null;
}

export class TestHttp {
  private readonly cookies = new Map<string, string>();

  /** Stable per-client source IP, sent as X-Forwarded-For on every request. */
  private readonly forwardedFor = nextTestClientIp();

  baseUrl = TEST_APP_URL;

  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /** Send a raw request and return the Response. Cookies are auto-captured. */
  async call(path: string, init: CallInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // Present this client's stable source IP so the app's per-IP rate limiter
    // buckets each test client separately (see nextTestClientIp).
    if (!headers.has("x-forwarded-for")) {
      headers.set("x-forwarded-for", this.forwardedFor);
    }
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const csrf = this.cookies.get("pda_csrf");
      if (csrf && !headers.has("x-csrf-token")) {
        headers.set("x-csrf-token", csrf);
      }
    }
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      body,
      redirect: "manual",
    });

    // Capture Set-Cookie. Node's undici exposes getSetCookie() — use it when
    // available, else fall back to parsing the raw header (a single string
    // join in older runtimes).
    const setCookies =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const firstPair = sc.split(";", 1)[0] ?? "";
      const eq = firstPair.indexOf("=");
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      if (value === "" || value === "deleted") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return res;
  }

  /** GET + JSON parse. Throws on non-2xx unless `allow` is set. */
  async getJson<T = unknown>(path: string, allow: number[] = []): Promise<T> {
    const res = await this.call(path);
    return this.parseOrThrow<T>(res, path, allow);
  }

  /** POST/PATCH/PUT/DELETE with JSON body. */
  async sendJson<T = unknown>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    json?: unknown,
    allow: number[] = [],
  ): Promise<T> {
    const res = await this.call(path, { method, json });
    return this.parseOrThrow<T>(res, path, allow);
  }

  private async parseOrThrow<T>(res: Response, path: string, allow: number[]): Promise<T> {
    const ok = res.status >= 200 && res.status < 300;
    if (!ok && !allow.includes(res.status)) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(
        `[TestHttp] ${path} → HTTP ${res.status}${detail ? `\n${detail.slice(0, 500)}` : ""}`,
      );
    }
    if (res.status === 204) return undefined as T;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return (await res.text()) as unknown as T;
    }
    return (await res.json()) as T;
  }
}

/** Construct a fresh client (empty cookie jar). */
export function anonClient(): TestHttp {
  return new TestHttp();
}
