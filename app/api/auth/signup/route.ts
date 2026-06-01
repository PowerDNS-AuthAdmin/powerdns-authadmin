/**
 * app/api/auth/signup/route.ts
 *
 * POST /api/auth/signup - public self-service registration, gated by
 * `SIGNUP_ENABLED`. Off by default; when disabled the route is a 404 (the
 * feature simply does not exist for that deployment).
 *
 * Security model (every property here is load-bearing - see issue #32):
 *   - Disabled → 404, before anything else runs.
 *   - Per-IP rate limit (same `sensitiveLimiter` tier as forgot-password).
 *   - CSRF handled like the other unauthenticated auth POSTs (no-op pre-session;
 *     `requireCsrf` only enforces when a session cookie is present, so it can't
 *     be CSRF-forged into an existing session).
 *   - Zod validation + the app-wide Argon2id password policy.
 *   - Email-domain allow-list (`SIGNUP_ALLOWED_EMAIL_DOMAINS`) enforced before
 *     any DB write; the audit row records the *domain* only, never the address.
 *   - No user enumeration: the response is identical whether or not the email
 *     already exists. A duplicate silently no-ops (re-sending verification to an
 *     existing UNVERIFIED local account) and never reveals that the account is
 *     there. We do NOT touch an already-verified account or an SSO/admin one.
 *   - The new account is created UNVERIFIED and assigned exactly the
 *     low-privilege `SIGNUP_DEFAULT_ROLE` - never an admin role (boot guard in
 *     `scripts/seed.ts` refuses to start otherwise). The user can't log in until
 *     they verify (see the gate in /api/auth/login).
 *   - User insert + role assignment + both audit rows commit in one
 *     transaction; a crash mid-sequence can't leave an unaudited/unroled user.
 *   - MFA is not required at signup; role policy can require it later.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestContext } from "@/lib/client-ip";
import { sensitiveLimiter } from "@/lib/auth/rate-limit";
import { requireCsrf } from "@/lib/auth/csrf";
import { verifyTurnstile } from "@/lib/auth/captcha";
import { hashPassword } from "@/lib/auth/password";
import { emailDomainAllowed } from "@/lib/auth/email-domain-allowlist";
import { mintVerifyToken } from "@/lib/auth/email-verification-token";
import { sendEmail } from "@/lib/email/send";
import { verifyEmailMessage } from "@/lib/email/templates";
import { db } from "@/lib/db";
import { findUserByEmail, insertUser } from "@/lib/db/repositories/users";
import { createRoleAssignment, findRoleBySlug } from "@/lib/db/repositories/roles";
import { signupSchema } from "@/lib/validators/users";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";

/**
 * Uniform success body. Returned for a fresh signup AND for a duplicate so the
 * endpoint is never an account-existence oracle. The copy is deliberately
 * agnostic about whether mail was sent vs. recorded in the audit log.
 */
const GENERIC_OK = {
  ok: true,
  message:
    "Thanks for signing up. If the address is eligible, a verification link is on its way - check your inbox (or ask your administrator if email isn't configured) and verify before signing in.",
};

function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function ok() {
  return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  // 1. Feature gate. A disabled deployment returns 404 - the route is invisible.
  if (!env.SIGNUP_ENABLED) {
    return jsonError(404, "Not found.");
  }

  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  const reqContext = getRequestContext(hdrs);

  // 2. CSRF - consistent with the other unauthenticated auth POSTs. No-op when
  //    there's no session (the normal signup case); enforced if a session
  //    cookie happens to be present so it can't be forged into an existing one.
  try {
    await requireCsrf(request);
  } catch {
    return jsonError(403, "CSRF token invalid or missing.");
  }

  // 3. Per-IP rate limit (shared bucket across replicas when Redis is set).
  const limit = await sensitiveLimiter.takeShared(`signup:${ip ?? "unknown"}`);
  if (!limit.allowed) {
    return jsonError(429, "Too many requests.", { retryAfterSeconds: limit.retryAfterSeconds });
  }

  // 4. Validate + enforce the password policy. Invalid input is a real 400 -
  //    it carries no account-existence signal (the address hasn't been looked
  //    up yet), so a precise validation error is safe and improves UX. We
  //    return the response inline (rather than throwing) because this handler
  //    builds its own Responses and has no outer errorResponse() catch.
  let body;
  try {
    body = signupSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      const validation = new ValidationError("Invalid input.", {
        fieldErrors: err.flatten().fieldErrors,
      });
      return Response.json(
        { error: validation.message, details: validation.details },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return jsonError(400, "Invalid request body.");
  }

  // 5. Captcha gate (same shape as login/forgot-password): enforced only when
  //    TURNSTILE_SECRET_KEY is set, verified BEFORE the DB lookup + hashing.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!body.captchaToken) {
      return jsonError(400, "Captcha required.", { reason: "captcha-required" });
    }
    const captcha = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: body.captchaToken,
      remoteIp: ip,
    });
    if (!captcha.ok) {
      logger.warn({ providerReasons: captcha.reasons }, "auth.signup.captcha-failed");
      return jsonError(400, "Captcha verification failed.", { reason: "captcha-failed" });
    }
  }

  // 6. Email-domain allow-list. Empty list = any domain. Rejection audits the
  //    domain only (never the full address) - PII minimisation, like OIDC's gate.
  const domainCheck = emailDomainAllowed(body.email, env.SIGNUP_ALLOWED_EMAIL_DOMAINS);
  if (!domainCheck.ok) {
    await appendAudit({
      actor: { type: "system", id: null },
      action: "auth.signup.rejected",
      resource: { type: "user", id: null },
      after: { domain: domainCheck.domain, reason: "domain-not-in-allow-list" },
      request: reqContext,
    });
    logger.warn({ domain: domainCheck.domain }, "auth.signup.domain-rejected");
    return jsonError(403, "Sign-ups from that email domain are not allowed.", {
      reason: "domain-not-allowed",
    });
  }

  // 7. Existing-account handling - the no-enumeration core. We never reveal
  //    whether the email is taken; both branches return the SAME GENERIC_OK.
  const existing = await findUserByEmail(body.email);
  if (existing) {
    // Re-send verification ONLY for a still-unverified LOCAL account - i.e. a
    // user who signed up but never finished. We do NOT touch:
    //   - verified accounts (already onboarded);
    //   - SSO-only accounts (no passwordHash - they verify via the IdP);
    //   - disabled accounts.
    // In all those cases we silently no-op so the response is indistinguishable
    // from a fresh signup, and we never reset/rotate an existing credential.
    if (
      existing.passwordHash &&
      existing.emailVerifiedAt === null &&
      existing.disabledAt === null
    ) {
      await issueVerification(existing.id, existing.email, reqContext, "resend");
    }
    return ok();
  }

  // 8. Resolve the default role up-front. Boot validated it exists + is
  //    low-privilege; if it's somehow gone now, fail closed (500) rather than
  //    create an unroled user - and stay non-enumerating about it.
  const defaultRole = await findRoleBySlug(env.SIGNUP_DEFAULT_ROLE);
  if (!defaultRole) {
    logger.error(
      { role: env.SIGNUP_DEFAULT_ROLE },
      "auth.signup.default-role-missing - refusing to create user without a role",
    );
    return jsonError(500, "Sign-up is temporarily unavailable.");
  }

  // 9. Create the unverified user + assign the default role + audit, atomically.
  const passwordHash = await hashPassword(body.password);
  let createdUserId: string;
  let createdEmail: string;
  try {
    const created = await db.transaction(async (tx) => {
      const row = await insertUser(
        {
          email: body.email,
          name: body.name ?? null,
          passwordHash,
          // Unverified by construction - the login gate keeps them out until
          // they redeem the verification link.
          emailVerifiedAt: null,
          // Self-service users pick their own password; no forced change.
          mustChangePassword: false,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "system", id: null },
          action: "user.create",
          resource: { type: "user", id: row.id },
          after: {
            email: row.email,
            name: row.name,
            source: "signup",
            initialRoleSlug: defaultRole.slug,
          },
          request: reqContext,
        },
        tx,
      );

      const assignment = await createRoleAssignment(
        {
          userId: row.id,
          roleId: defaultRole.id,
          scopeType: "global",
          scopeId: null,
          // No human actor - self-service. Null mirrors the bootstrap-seed grant.
          createdBy: null,
        },
        tx,
      );
      await appendAudit(
        {
          actor: { type: "system", id: null },
          action: "role.assignment.created",
          resource: { type: "user", id: row.id },
          after: {
            assignmentId: assignment.id,
            roleId: defaultRole.id,
            roleSlug: defaultRole.slug,
            scopeType: "global",
            scopeId: null,
            source: "signup",
          },
          request: reqContext,
        },
        tx,
      );

      return row;
    });
    createdUserId = created.id;
    createdEmail = created.email;
  } catch (err) {
    // A unique-constraint race (two concurrent signups for the same address)
    // lands here. Stay non-enumerating: return the SAME GENERIC_OK as success.
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "auth.signup.insert-conflict-or-error",
    );
    return ok();
  }

  // 10. Send the verification link (outside the tx - email is best-effort and
  //     must not roll back a committed user). SMTP-off falls back to the audit
  //     log, exactly like forgot-password / send-verification.
  await issueVerification(createdUserId, createdEmail, reqContext, "signup");

  logger.info({ userId: createdUserId, role: defaultRole.slug }, "auth.signup.created");
  return ok();
}

/**
 * Mint a `pde_…` verification token for a user and deliver it: email when SMTP
 * is configured, otherwise record the link in the audit log so an operator can
 * share it out-of-band. Mirrors `/api/auth/email/send-verification`. Best-effort
 * - failures are logged, never surfaced (keeps the response non-enumerating).
 */
async function issueVerification(
  userId: string,
  email: string,
  reqContext: ReturnType<typeof getRequestContext>,
  origin: "signup" | "resend",
): Promise<void> {
  const { token } = mintVerifyToken({ userId, email, secret: env.APP_SECRET_KEY });
  const verifyUrl = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const mail = await sendEmail({
    to: email,
    kind: "email-verification",
    ...verifyEmailMessage(verifyUrl),
  });

  await appendAudit({
    actor: { type: "system", id: null },
    action: "auth.email.verify.sent",
    resource: { type: "user", id: userId },
    after: {
      email,
      origin,
      // Keep the tokenised link in the audit ONLY when SMTP is off, so an
      // operator can still share it. When emailed, the token stays out of audit.
      ...(mail.skipped ? { url: verifyUrl } : {}),
      delivered: mail.ok && !mail.skipped,
    },
    request: reqContext,
  });

  if (mail.skipped) {
    logger.warn(
      { userId, verifyUrl },
      "auth.signup.verify-sent - SMTP disabled; share this URL with the user out-of-band",
    );
  } else if (!mail.ok) {
    logger.error({ userId, error: mail.error }, "auth.signup.verify-send-failed");
  }
}
