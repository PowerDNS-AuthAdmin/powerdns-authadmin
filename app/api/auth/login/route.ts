/**
 * app/api/auth/login/route.ts
 *
 * POST /api/auth/login — local email + password login.
 *
 * Steps:
 *   1. Parse + validate input.
 *   2. Rate-limit by IP and by email separately. Either limit triggering
 *      returns 429 with `Retry-After`.
 *   3. Verify credentials via `authenticateLocal`.
 *   4. On success: start a session, audit-log, return 200 with the user.
 *   5. On failure: audit-log the attempt, return 401 (uniform error to avoid
 *      account-existence leakage).
 *
 * Throws are caught by the framework's error handler; we expose minimal
 * detail in error responses to avoid leaking internal state.
 */

import { headers } from "next/headers";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { authenticateLocal } from "@/lib/auth/providers/local";
import { startSession } from "@/lib/auth/session";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { verifyTurnstile } from "@/lib/auth/captcha";
import { mint as mintRevealToken } from "@/lib/auth/temp-reveal-store";
import { appendAudit } from "@/lib/audit/log";

const bodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
  // Cloudflare Turnstile response token. Required when TURNSTILE_SECRET_KEY
  // is configured; ignored otherwise. The schema accepts it unconditionally
  // so dev clients without the widget can still submit, and the server
  // enforces the requirement based on env.
  captchaToken: z.string().max(4096).optional(),
});

function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!env.LOCAL_AUTH_ENABLED) {
    return jsonError(404, "Local authentication is disabled.");
  }

  // 1. Parse + validate
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return jsonError(400, "Invalid request body.");
  }

  const hdrs = await headers();
  const ip = clientIp(hdrs);
  const userAgent = hdrs.get("user-agent");

  // 2a. Captcha. Only enforced when TURNSTILE_SECRET_KEY is configured —
  // skips cleanly in dev so the local stack keeps working without keys.
  // Verified BEFORE rate-limiting so a bot stream doesn't burn the per-IP
  // budget; verified BEFORE credential checking so a missing/invalid token
  // never reaches the password hasher.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!body.captchaToken) {
      await appendAudit({
        actor: { type: "user", id: null },
        action: "auth.login.failure",
        resource: { type: "auth", id: body.email.toLowerCase() },
        after: { reason: "captcha-missing" },
        request: { ip, userAgent, requestId: getRequestId(hdrs) },
      });
      return jsonError(400, "Captcha required.", { reason: "captcha-required" });
    }
    const captcha = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: body.captchaToken,
      remoteIp: ip,
    });
    if (!captcha.ok) {
      await appendAudit({
        actor: { type: "user", id: null },
        action: "auth.login.failure",
        resource: { type: "auth", id: body.email.toLowerCase() },
        after: { reason: "captcha-failed", providerReasons: captcha.reasons },
        request: { ip, userAgent, requestId: getRequestId(hdrs) },
      });
      logger.warn(
        { providerReasons: captcha.reasons, requestId: getRequestId(hdrs) },
        "auth.login.captcha-failed",
      );
      return jsonError(400, "Captcha verification failed.", {
        reason: "captcha-failed",
      });
    }
  }

  // 2b. Per-IP rate limit. The IP comes from the fronting proxy's forwarded
  // headers; if one is absent (no proxy — a misconfiguration where all
  // traffic is unattributed anyway) we fall back to a shared bucket so the
  // limiter still applies.
  //
  // S-11: the per-email rate-limit that used to live here was removed —
  // it let an off-path attacker spamming wrong passwords for `victim@org`
  // from many IPs lock the legitimate user out of the form (separately
  // from the account-lockout below, with a different UX path). The
  // defenses left are:
  //   - per-IP token bucket (this block) — slows a single source
  //   - per-account lockout in `recordFailedLogin()` (10 attempts → 15
  //     min lockout) — catches IP-distributed credential spray
  // The lockout window is the only ceiling on online password guessing
  // against a known account and it's tight enough to make brute-force
  // online cred-spray uneconomical (max 96 attempts/day per account at
  // 10 attempts / 15 min).
  const ipLimit = await loginLimiter.takeShared(`ip:${ip ?? "unknown"}`);
  if (!ipLimit.allowed) {
    return jsonError(429, "Too many login attempts.", {
      retryAfterSeconds: ipLimit.retryAfterSeconds,
    });
  }

  // 3. Verify
  const outcome = await authenticateLocal({
    email: body.email,
    password: body.password,
    ip,
  });

  if (outcome.kind !== "ok") {
    await appendAudit({
      actor: { type: "user", id: null },
      action: "auth.login.failure",
      resource: { type: "auth", id: body.email.toLowerCase() },
      after: { reason: outcome.kind },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });

    if (outcome.kind === "locked-out") {
      return jsonError(429, "Account temporarily locked.", {
        unlockAt: outcome.unlockAt.toISOString(),
      });
    }
    // Uniform message for invalid-credentials AND disabled — don't leak
    // which it is. Audit log captures the truth.
    return jsonError(401, "Invalid email or password.");
  }

  // 3b. Email-verification gate. When public self-service signup is enabled,
  // the deployment commits to "verify your email before you get in" — otherwise
  // an attacker could register `someone-else@org.com` and access the app without
  // ever owning that mailbox. We block any local-password account whose email
  // isn't verified yet. SSO-only accounts (no passwordHash) never reach this
  // branch; admins clear the gate out-of-band via the verification link recorded
  // in the audit log, and a repeat POST to /api/auth/signup re-sends it.
  //
  // Entirely inert when SIGNUP_ENABLED=false: deployments that never turn on
  // public signup keep the pre-existing soft-banner behavior unchanged.
  if (
    env.SIGNUP_ENABLED &&
    outcome.user.passwordHash !== null &&
    outcome.user.emailVerifiedAt === null
  ) {
    await appendAudit({
      actor: { type: "user", id: outcome.user.id },
      action: "auth.login.failure",
      resource: { type: "user", id: outcome.user.id },
      after: { reason: "email-unverified" },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });
    return jsonError(403, "Verify your email address before signing in.", {
      reason: "email-unverified",
    });
  }

  // 4. MFA challenge — when the user has TOTP enrolled, do NOT
  // start a session yet. Mint a single-use challenge token bound to
  // the constant actor "_mfa-pending" (the operator isn't logged in
  // yet so we can't bind to user.id at redeem time; the token itself
  // is the bearer credential). The browser's MFA step posts the
  // token + the 6-digit code to /api/auth/mfa/totp to finish.
  if (outcome.user.totpSecretEncrypted) {
    const { token: challengeToken, expiresInSec } = await mintRevealToken({
      plaintext: outcome.user.id,
      allowedActorId: "_mfa-pending",
      ttlSec: 5 * 60,
    });
    await appendAudit({
      actor: { type: "user", id: outcome.user.id },
      action: "auth.login.success",
      resource: { type: "user", id: outcome.user.id },
      after: { mfaRequired: true },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });
    return Response.json(
      { mfaRequired: true, challengeToken, expiresInSec },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 5. Start session (no MFA needed)
  await startSession({
    userId: outcome.user.id,
    ip,
    userAgent,
  });

  await appendAudit({
    actor: { type: "user", id: outcome.user.id },
    action: "auth.login.success",
    resource: { type: "user", id: outcome.user.id },
    request: { ip, userAgent },
  });

  logger.info({ userId: outcome.user.id, source: "local" }, "auth.login.success");

  return Response.json(
    {
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        name: outcome.user.name,
        mustChangePassword: outcome.user.mustChangePassword,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Extract the client IP from typical proxy headers, falling back to null. */
function clientIp(hdrs: Headers): string | null {
  return getClientIp(hdrs);
}
