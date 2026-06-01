/**
 * app/api/auth/ldap/[slug]/login/route.ts
 *
 * POST /api/auth/ldap/<slug>/login - direct-bind sign-in against an LDAP
 * provider configured under /admin/authentication/ldap.
 *
 * Body: `{ username, password, captchaToken? }`.
 *
 * Flow (same posture as the local + OIDC paths):
 *   1. Resolve the provider (404 on unknown / disabled slug).
 *   2. Captcha (Turnstile, if configured) - verified before rate limit so a
 *      bot stream can't burn the per-IP budget.
 *   3. Per-IP rate limit (the shared `loginLimiter` bucket - LDAP shares
 *      with local login on purpose).
 *   4. `authenticateLdap()` - bind, search, re-bind, claim extraction.
 *   5. Auto-provision the local `users` row (with the same email-domain
 *      allow-list gate OIDC uses; LDAP-only, no env default).
 *   6. Group sync via `applyGroupSync` (reused from the OIDC path).
 *   7. Start the session; audit `auth.login.success` with `method: "ldap"`.
 */

import { headers } from "next/headers";
import { ZodError, type infer as ZodInfer } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { authenticateLdap, resolveLdapProvider } from "@/lib/auth/providers/ldap";
import { computeGroupSync } from "@/lib/auth/providers/group-sync";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { verifyTurnstile } from "@/lib/auth/captcha";
import { startSession } from "@/lib/auth/session";
import { findUserByEmail, insertUser, recordSuccessfulLogin } from "@/lib/db/repositories/users";
import { emailDomainAllowed } from "@/lib/auth/email-domain-allowlist";
import { ldapLoginSchema } from "@/lib/validators/ldap-providers";

function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    return await handleLdapLogin(request, context);
  } catch (err) {
    // Last-resort safety net: a directory misconfig (unresolvable host,
    // wrong port, malformed bind DN) should still get an operator-friendly
    // response instead of a blank 500 page. `authenticateLdap` already has
    // its own outer try/catch, so getting here means something even further
    // upstream broke - log loud, return 502.
    const slug = await context.params.then((p) => p.slug).catch(() => "<unknown>");
    logger.error(
      { provider: slug, err: err instanceof Error ? err.message : "unknown" },
      "ldap.login.route.unexpected-error",
    );
    return jsonError(502, "Could not reach the directory.");
  }
}

async function handleLdapLogin(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;

  const provider = await resolveLdapProvider(slug);
  if (!provider) {
    return jsonError(404, "Unknown or disabled LDAP provider.");
  }

  let body: ZodInfer<typeof ldapLoginSchema>;
  try {
    body = ldapLoginSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return jsonError(400, "Invalid request body.", {
        fieldErrors: err.flatten().fieldErrors,
      });
    }
    return jsonError(400, "Invalid request body.");
  }

  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  const userAgent = hdrs.get("user-agent");
  const requestContext = { ip, userAgent, requestId: getRequestId(hdrs) };

  // Captcha - verified first so a bot can't burn the per-IP budget. Only
  // enforced when the env binds a secret; dev stacks without keys skip
  // cleanly.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!body.captchaToken) {
      await appendAudit({
        actor: { type: "user", id: null },
        action: "auth.login.failure",
        resource: { type: "auth", id: body.username.toLowerCase() },
        after: { method: "ldap", provider: provider.slug, reason: "captcha-missing" },
        request: requestContext,
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
        resource: { type: "auth", id: body.username.toLowerCase() },
        after: {
          method: "ldap",
          provider: provider.slug,
          reason: "captcha-failed",
          providerReasons: captcha.reasons,
        },
        request: requestContext,
      });
      return jsonError(400, "Captcha verification failed.", { reason: "captcha-failed" });
    }
  }

  // Shared per-IP bucket with the local login route. An off-path attacker
  // can't double their budget by alternating between the two.
  const ipLimit = await loginLimiter.takeShared(`ip:${ip ?? "unknown"}`);
  if (!ipLimit.allowed) {
    return jsonError(429, "Too many login attempts.", {
      retryAfterSeconds: ipLimit.retryAfterSeconds,
    });
  }

  const result = await authenticateLdap({
    provider,
    username: body.username,
    password: body.password,
  });

  if ("rejected" in result) {
    await appendAudit({
      actor: { type: "user", id: null },
      action: "auth.login.failure",
      resource: { type: "auth", id: body.username.toLowerCase() },
      after: { method: "ldap", provider: provider.slug, reason: result.rejected },
      request: requestContext,
    });
    // Uniform 401 for invalid creds / user-not-found - don't leak account
    // existence to a fishing attacker. Transport / TLS errors go 502 so
    // operators see the difference in their logs.
    if (result.rejected === "transport" || result.rejected === "tls") {
      return jsonError(502, "Could not reach the directory.", {
        reason: result.rejected,
      });
    }
    return jsonError(401, "Invalid username or password.");
  }

  const identity = result;

  // Auto-provision OR look up the local row. The email is what we key
  // accounts by everywhere in the app; LDAP usernames vary by directory
  // (sAMAccountName, uid, mail) but we always resolve to a verified email
  // before issuing a session.
  let user = await findUserByEmail(identity.email);
  if (!user) {
    // Provisioning gate. LDAP providers carry their own allow-list with
    // no env-level fallback (the OIDC env list doesn't apply here). Null /
    // empty array = no restriction.
    const domains = provider.allowedEmailDomains ?? [];
    const check = emailDomainAllowed(identity.email, domains);
    if (!check.ok) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.idp.rejected_provisioning",
        resource: { type: "user", id: null },
        after: {
          source: identity.source,
          domain: check.domain,
          reason: "domain-not-in-allow-list",
        },
        request: requestContext,
      });
      logger.warn(
        { provider: provider.slug, domain: check.domain },
        "ldap.login.provisioning-rejected",
      );
      return jsonError(403, "Sign-in refused: your account is not authorized for this system.", {
        reason: "ldap-not-authorized",
      });
    }
    user = await insertUser({
      email: identity.email,
      name: identity.name ?? null,
      // LDAP IS the verification - operators trust their directory to
      // own the email field. Same posture as OIDC with
      // requireEmailVerified=false (the default).
      emailVerifiedAt: new Date(),
      passwordHash: null,
    });
    await appendAudit({
      actor: { type: "system", id: null },
      action: "user.create",
      resource: { type: "user", id: user.id },
      after: { email: user.email, source: identity.source },
      request: requestContext,
    });
  }

  await recordSuccessfulLogin(user.id, ip ?? null);

  // Compute the IdP-derived permission set for this sign-in.
  // `claims.groups` is the array of group memberships we extracted from
  // the LDAP user entry (or the optional second search). The result is
  // persisted onto the session row in `startSession`.
  let derivedPermissions: Awaited<ReturnType<typeof computeGroupSync>>["derived"] = [];
  try {
    const result = await computeGroupSync({
      groupsClaim: identity.claims?.["groups"],
      mappings: provider.groupMappings,
    });
    derivedPermissions = result.derived;
    for (const u of result.unresolved) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.group_sync.mapping_unresolved",
        resource: { type: "user", id: user.id },
        after: { provider: provider.slug, ...u },
        request: requestContext,
      });
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : "unknown",
        userId: user.id,
        provider: provider.slug,
      },
      "ldap.login.group-sync-failed",
    );
  }

  await startSession({
    userId: user.id,
    ip: ip ?? null,
    userAgent,
    derivedPermissions,
    idp: { type: "ldap", slug: provider.slug },
  });

  await appendAudit({
    actor: { type: "user", id: user.id },
    action: "auth.login.success",
    resource: { type: "user", id: user.id },
    after: { source: identity.source, method: "ldap", provider: provider.slug },
    request: requestContext,
  });

  logger.info(
    { userId: user.id, source: identity.source, requestId: getRequestId(hdrs) },
    "auth.ldap.success",
  );

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
