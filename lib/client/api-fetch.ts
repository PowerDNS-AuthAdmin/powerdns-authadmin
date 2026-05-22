/**
 * lib/client/api-fetch.ts
 *
 * Thin `fetch` wrapper for client components. On state-changing methods
 * (POST/PATCH/PUT/DELETE) it reads the `pda_csrf` cookie and copies it into
 * the `x-csrf-token` header — the client half of the double-submit CSRF
 * protection that `lib/auth/csrf.ts#requireCsrf` validates on the server.
 *
 * Use this for every mutation from a client component. GET-style calls
 * don't need it but going through the wrapper anyway is fine; it short-
 * circuits the header injection on safe methods.
 *
 * This module is browser-only — it touches `document.cookie`. The
 * `client-only` import causes any accidental server import to fail loudly
 * at build time.
 */

import "client-only";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  // Cookie format: "key=value; key2=value2". Match the named cookie's value.
  const match = /(?:^|;\s*)pda_csrf=([^;]+)/.exec(document.cookie);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

/**
 * `fetch` for the in-app client. Adds `x-csrf-token` on mutating methods.
 *
 * Falls back to a plain `fetch` if the CSRF cookie is missing (e.g. before
 * sign-in or after sign-out) — the server will reject the request anyway
 * if a session cookie is present.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return fetch(input, init);
  }

  const token = readCsrfCookie();
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init.headers);
  if (!headers.has("x-csrf-token")) {
    headers.set("x-csrf-token", token);
  }
  return fetch(input, { ...init, headers });
}

export type MutateResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

/**
 * `apiFetch` + the standard "parse JSON, pull `{ error }` out on failure" idiom
 * that was hand-rolled in ~49 components. Returns a discriminated result so
 * callers branch on `.ok` instead of repeating the response/JSON dance:
 *
 *   const r = await mutate("/api/...", { method: "DELETE" });
 *   if (!r.ok) { toast({ kind: "error", description: r.error }); return; }
 *
 * A non-JSON or empty body (e.g. 204) yields `data: null` on success and the
 * generic message on failure.
 */
export async function mutate<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<MutateResult<T>> {
  const res = await apiFetch(input, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Unexpected error.";
    return { ok: false, error, status: res.status };
  }
  return { ok: true, data: body as T };
}
