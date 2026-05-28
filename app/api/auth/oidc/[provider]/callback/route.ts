/**
 * app/api/auth/oidc/[provider]/callback/route.ts
 *
 * GET /api/auth/oidc/<provider>/callback
 *
 * Returns from the IdP after the user authorized us. Steps:
 *   1. Validate `<provider>` against the configured one.
 *   2. Read state + PKCE verifier + nonce from cookies; clear them.
 *   3. Exchange the code via `completeAuthorization` (validates state, nonce,
 *      the ID token signature, claims).
 *   4. Look up or create the local `users` row keyed by claim-email.
 *   5. Start a session, audit-log, redirect to `/dashboard`.
 *
 * Errors render a clean error page rather than dumping raw provider errors
 * to the user. Details go to logs + audit.
 */

import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/redact";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import {
  completeAuthorization,
  describeOidcError,
  emailDomainAllowed,
  readAuthMethodChoice,
  resolveAllowedDomains,
  resolveOidcProvider,
} from "@/lib/auth/providers/oidc";
import { computeGroupSync } from "@/lib/auth/providers/group-sync";
import { encrypt } from "@/lib/crypto/encryption";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { startSession } from "@/lib/auth/session";
import { findUserByEmail, insertUser, recordSuccessfulLogin } from "@/lib/db/repositories/users";

const OIDC_STATE_COOKIE = "pda_oidc_state";
const OIDC_PKCE_COOKIE = "pda_oidc_pkce";
const OIDC_NONCE_COOKIE = "pda_oidc_nonce";
const OIDC_SLUG_COOKIE = "pda_oidc_slug";
const OIDC_NEXT_COOKIE = "pda_oidc_next";

function failRedirect(reason: string): Response {
  const target = new URL(`${env.APP_URL}/login`);
  target.searchParams.set("error", reason);
  return Response.redirect(target.toString(), 302);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: slugFromUrl } = await context.params;

  const cookieStore = await cookies();
  const state = cookieStore.get(OIDC_STATE_COOKIE)?.value;
  const codeVerifier = cookieStore.get(OIDC_PKCE_COOKIE)?.value;
  const nonce = cookieStore.get(OIDC_NONCE_COOKIE)?.value;
  const slugFromCookie = cookieStore.get(OIDC_SLUG_COOKIE)?.value;
  // Attempted destination (L-2), validated below before use.
  const nextFromCookie = cookieStore.get(OIDC_NEXT_COOKIE)?.value;
  // Clear the short-lived cookies immediately, regardless of outcome.
  cookieStore.delete(OIDC_STATE_COOKIE);
  cookieStore.delete(OIDC_PKCE_COOKIE);
  cookieStore.delete(OIDC_NONCE_COOKIE);
  cookieStore.delete(OIDC_SLUG_COOKIE);
  cookieStore.delete(OIDC_NEXT_COOKIE);

  // The slug we trust is the one we stored at initiate-time, not the path
  // segment — defends against an attacker swapping `<provider>` in the URL
  // during the round-trip to point our token exchange at a different IdP.
  if (slugFromCookie && slugFromCookie !== slugFromUrl) {
    return failRedirect("oidc-unknown-provider");
  }
  const slug = slugFromCookie ?? slugFromUrl;

  const provider = await resolveOidcProvider(slug);
  if (!provider) {
    return failRedirect("oidc-unknown-provider");
  }

  if (!state || !codeVerifier || !nonce) {
    return failRedirect("oidc-state-missing");
  }

  let identity;
  try {
    // openid-client v6 derives the `redirect_uri` it sends in the
    // token-exchange request from `callbackUrl.origin + pathname`. In
    // a containerized deploy behind a reverse proxy, `request.url` is
    // what the Node process sees — typically the INTERNAL URL
    // (http://app:3000/...) — and that does NOT match what was sent
    // to authentik at /authorize OR what's registered as the
    // Redirect URI on the IdP. authentik then rejects the exchange
    // as `invalid_client` (its name for "redirect_uri mismatch").
    //
    // Fix: rebuild a URL with the registered origin + path (from
    // env.APP_URL + provider slug, same source the initiate handler
    // uses) and copy the IdP's response query (code, state, iss…)
    // onto it. Same redirect_uri at /authorize and /token = no mismatch.
    const incoming = new URL(request.url);
    const callbackUrl = new URL(`${env.APP_URL}/api/auth/oidc/${slug}/callback`);
    callbackUrl.search = incoming.search;

    identity = await completeAuthorization({
      provider,
      callbackUrl,
      state,
      codeVerifier,
      nonce,
    });
  } catch (cause) {
    const detail = describeOidcError(cause);
    const authChoice = readAuthMethodChoice(provider);
    logger.warn(
      {
        provider: slug,
        // `err` keeps the generic library message for grep continuity
        // with older log lines; the structured fields below are the
        // operator-actionable ones.
        err: safeErrorMessage(cause),
        oauth_error: detail.error,
        oauth_error_description: detail.error_description,
        http_status: detail.status,
        oidc_code: detail.code,
        body: detail.body,
        // Auth-method context — invaluable when the IdP returns
        // `invalid_client` because we picked the wrong method or
        // because the secret stored in the DB is stale.
        auth_method_used: authChoice?.chosen,
        auth_methods_supported: authChoice?.supported,
        secret_len: provider.clientSecret.length,
        // Smoking gun for the "secret was double-encrypted" failure
        // mode. If true, the value we sent to the IdP IS one of our
        // encryption envelopes (or coincidentally starts with `v1:`
        // followed by three base64url segments). Operator action:
        // re-save the secret on the OIDC provider admin page.
        secret_looks_like_envelope: provider.clientSecret.startsWith("v1:"),
      },
      "oidc.callback.failure",
    );
    return failRedirect("oidc-exchange-failed");
  }

  // Upsert the user by email.strategy: auto-provision on first
  // login. future work will add an "allowed domains" setting that gates this.
  let user = await findUserByEmail(identity.email);
  if (user) {
    // Account-takeover guard: if a local row with this email already exists,
    // refuse to sign the OIDC actor into it unless the IdP attests the email
    // is verified. Without this check, an IdP that lets users set arbitrary
    // unverified emails would let any attacker claim "admin@yourorg.com" and
    // sign in as the local admin.
    //
    // Per-provider opt-out: `requireEmailVerified=false` skips the check.
    // Operators flip it off only for IdPs that don't emit the claim at all
    // (custom OIDC bridges, some SAML→OIDC translators).
    if (provider.requireEmailVerified && identity.emailVerified !== true) {
      const hdrsForAudit = await headers();
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.login.failure",
        resource: { type: "user", id: user.id },
        after: {
          source: identity.source,
          reason: "oidc-email-unverified-existing-account",
        },
        request: {
          ip: getClientIp(hdrsForAudit),
          userAgent: hdrsForAudit.get("user-agent"),
          requestId: getRequestId(hdrsForAudit),
        },
      });
      logger.warn(
        { provider: provider.slug, userId: user.id },
        "oidc.callback.email-unverified-existing-account",
      );
      return failRedirect("oidc-email-unverified");
    }
  } else {
    // Provisioning gate: when OIDC_ALLOWED_EMAIL_DOMAINS is set, refuse to
    // auto-create a local user for an email outside the allow-list. Existing
    // users are unaffected (they hit the branch above). The audit row stores
    // the *domain* only — never the full rejected address — so a misdirected
    // login attempt doesn't leak the would-be username into our retention.
    // Per-provider override (S-7 follow-up): when `provider.allowedEmailDomains`
    // is non-null it REPLACES the env list for this provider; null inherits env.
    // See `lib/auth/email-domain-allowlist.ts` for the resolution rules.
    const effectiveDomains = resolveAllowedDomains(
      provider.allowedEmailDomains,
      env.OIDC_ALLOWED_EMAIL_DOMAINS,
    );
    const check = emailDomainAllowed(identity.email, effectiveDomains);
    if (!check.ok) {
      const hdrsForAudit = await headers();
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.idp.rejected_provisioning",
        resource: { type: "user", id: null },
        after: {
          source: identity.source,
          domain: check.domain,
          reason: "domain-not-in-allow-list",
        },
        request: {
          ip: getClientIp(hdrsForAudit),
          userAgent: hdrsForAudit.get("user-agent"),
          requestId: getRequestId(hdrsForAudit),
        },
      });
      logger.warn(
        { provider: provider.slug, domain: check.domain },
        "oidc.callback.provisioning-rejected",
      );
      return failRedirect("oidc-not-authorized");
    }

    user = await insertUser({
      email: identity.email,
      name: identity.name ?? null,
      emailVerifiedAt: identity.emailVerified ? new Date() : null,
      passwordHash: null,
    });
    await appendAudit({
      actor: { type: "system", id: null },
      action: "user.create",
      resource: { type: "user", id: user.id },
      after: { email: user.email, source: identity.source },
    });
  }

  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  const userAgent = hdrs.get("user-agent");

  await recordSuccessfulLogin(user.id, ip ?? null);

  // Compute the IdP-derived permission set for this sign-in. The result
  // gets persisted onto the session row in `startSession` below — not
  // into `role_assignments`. Env-source providers (no id, no mappings)
  // produce an empty array.
  let derivedPermissions: Awaited<ReturnType<typeof computeGroupSync>>["derived"] = [];
  if (provider.id) {
    try {
      const result = await computeGroupSync({
        groupsClaim: identity.claims?.[provider.claimGroups],
        mappings: provider.groupMappings,
      });
      derivedPermissions = result.derived;
      for (const u of result.unresolved) {
        await appendAudit({
          actor: { type: "system", id: null },
          action: "auth.group_sync.mapping_unresolved",
          resource: { type: "user", id: user.id },
          after: { provider: provider.slug, ...u },
          request: { ip, userAgent, requestId: getRequestId(hdrs) },
        });
      }
    } catch (err) {
      logger.warn(
        { err: safeErrorMessage(err), userId: user.id, provider: provider.slug },
        "oidc.callback.group-sync-failed",
      );
    }
  }

  await startSession({
    userId: user.id,
    ip: ip ?? null,
    userAgent,
    derivedPermissions,
    idp: { type: "oidc", slug: provider.slug },
    ...(identity.oidcLogout
      ? {
          oidc: {
            endSessionUrl: identity.oidcLogout.endSessionUrl,
            idToken: identity.oidcLogout.idToken,
            clientId: identity.oidcLogout.clientId,
            // Refresh token is encrypted at write time; `getCurrentUser`'s
            // token-auth path decrypts to call the IdP's userinfo for a
            // live groups recheck.
            refreshTokenEncrypted: identity.oidcLogout.refreshToken
              ? encrypt(identity.oidcLogout.refreshToken, "oidc-refresh-token")
              : null,
          },
        }
      : {}),
  });

  await appendAudit({
    actor: { type: "user", id: user.id },
    action: "auth.login.success",
    resource: { type: "user", id: user.id },
    after: { source: identity.source },
    request: { ip, userAgent, requestId: getRequestId(hdrs) },
  });

  logger.info(
    { userId: user.id, source: identity.source, requestId: getRequestId(hdrs) },
    "auth.oidc.success",
  );

  return Response.redirect(`${env.APP_URL}${safeNextPath(nextFromCookie)}`, 302);
}
