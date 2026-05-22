/**
 * lib/auth/captcha.ts
 *
 * Cloudflare Turnstile token verification. Used by the login route (S-4)
 * to confirm a human submitted the form before consuming any auth budget.
 *
 * The verify call is a plain HTTPS POST to Cloudflare's `siteverify`
 * endpoint with `secret` + `response` + optional `remoteip`. We never log
 * the token (it's single-use against Cloudflare anyway, but it ties back
 * to the user's session and there's no reason to retain it).
 *
 * Sizing: Cloudflare states tokens are valid for 5 minutes and can only
 * be redeemed once. We rely on the upstream's enforcement rather than
 * tracking redemption ourselves.
 *
 * This module does NOT read env — callers pass the secret. That keeps the
 * verifier easy to unit-test (no module-level state, no boot-time
 * coupling) and lets the route decide when captcha is required (e.g.
 * "skip in dev when secret isn't configured").
 */

import "server-only";

const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Successful verification — Cloudflare attests the token came from a human. */
export interface CaptchaOk {
  ok: true;
}

/** Failed verification — provider rejected the token or transport failed. */
export interface CaptchaFail {
  ok: false;
  /** `siteverify` error-codes (or `transport-error` for fetch/parse failures). */
  reasons: string[];
}

export type CaptchaResult = CaptchaOk | CaptchaFail;

/**
 * Verify a Turnstile token. Returns `{ ok: true }` on success.
 *
 * @param secret    — TURNSTILE_SECRET_KEY from env
 * @param token     — the `cf-turnstile-response` value from the form
 * @param remoteIp  — optional client IP (from the proxy's forwarded
 *                    headers), hardens the verification; safe to omit
 * @param fetchImpl — overridable for tests; defaults to global `fetch`
 */
export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  remoteIp?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<CaptchaResult> {
  if (!input.token || input.token.length === 0) {
    return { ok: false, reasons: ["missing-input-response"] };
  }

  const body = new URLSearchParams();
  body.set("secret", input.secret);
  body.set("response", input.token);
  if (input.remoteIp) body.set("remoteip", input.remoteIp);

  const fetcher = input.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetcher(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
      // No `Content-Type` header set — `URLSearchParams` auto-encodes as
      // application/x-www-form-urlencoded, which is what siteverify expects.
    });
  } catch {
    return { ok: false, reasons: ["transport-error"] };
  }

  if (!res.ok) {
    return { ok: false, reasons: [`http-${res.status}`] };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, reasons: ["invalid-json"] };
  }

  if (!isSiteverifyResponse(parsed)) {
    return { ok: false, reasons: ["malformed-response"] };
  }
  if (parsed.success === true) {
    return { ok: true };
  }
  return {
    ok: false,
    reasons:
      Array.isArray(parsed["error-codes"]) && parsed["error-codes"].length > 0
        ? parsed["error-codes"]
        : ["verification-failed"],
  };
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

function isSiteverifyResponse(v: unknown): v is SiteverifyResponse {
  return typeof v === "object" && v !== null && "success" in v;
}
