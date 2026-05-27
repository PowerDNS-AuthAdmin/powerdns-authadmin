/**
 * app/api/auth/saml/[slug]/acs/route.ts
 *
 * POST /api/auth/saml/<slug>/acs — Assertion Consumer Service.
 *
 * The IdP form-POSTs `SAMLResponse` here (and optionally `RelayState`) after
 * the user authenticates. We:
 *
 *   1. Validate the URL slug against the cookie value the /login handler set.
 *   2. Hand the response XML to `verifyResponse` — signature + InResponseTo
 *      + encrypted-assertion decryption all happen inside.
 *   3. Find-or-create the local `users` row keyed on the email attribute
 *      (with the same email-domain gate OIDC has).
 *   4. Materialise group → role mappings via the shared `applyGroupSync`.
 *   5. Mint a session, audit-log, redirect.
 */

import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/redact";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import {
  describeSamlError,
  emailDomainAllowed,
  resolveAllowedDomains,
  resolveSamlProvider,
  verifyResponse,
} from "@/lib/auth/providers/saml";
import { computeGroupSync } from "@/lib/auth/providers/group-sync";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { startSession } from "@/lib/auth/session";
import { findUserByEmail, insertUser, recordSuccessfulLogin } from "@/lib/db/repositories/users";

const SAML_STATE_COOKIE = "pda_saml_state";
const SAML_SLUG_COOKIE = "pda_saml_slug";
const SAML_NEXT_COOKIE = "pda_saml_next";

function failRedirect(reason: string): Response {
  const target = new URL(`${env.APP_URL}/login`);
  target.searchParams.set("error", reason);
  return Response.redirect(target.toString(), 302);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug: slugFromUrl } = await context.params;

  const cookieStore = await cookies();
  const expectedRequestId = cookieStore.get(SAML_STATE_COOKIE)?.value;
  const slugFromCookie = cookieStore.get(SAML_SLUG_COOKIE)?.value;
  const nextFromCookie = cookieStore.get(SAML_NEXT_COOKIE)?.value;
  cookieStore.delete(SAML_STATE_COOKIE);
  cookieStore.delete(SAML_SLUG_COOKIE);
  cookieStore.delete(SAML_NEXT_COOKIE);

  if (slugFromCookie && slugFromCookie !== slugFromUrl) {
    return failRedirect("saml-unknown-provider");
  }
  const slug = slugFromCookie ?? slugFromUrl;

  const provider = await resolveSamlProvider(slug);
  if (!provider) {
    return failRedirect("saml-unknown-provider");
  }

  if (!expectedRequestId) {
    return failRedirect("saml-state-missing");
  }

  // Read the form body — the IdP POSTs application/x-www-form-urlencoded.
  let samlResponse: string;
  try {
    const form = await request.formData();
    const raw = form.get("SAMLResponse");
    if (typeof raw !== "string" || raw.length === 0) {
      return failRedirect("saml-response-missing");
    }
    samlResponse = raw;
  } catch (err) {
    logger.warn(
      { provider: provider.slug, err: safeErrorMessage(err) },
      "saml.acs.body-parse-failed",
    );
    return failRedirect("saml-response-missing");
  }

  const callbackUrl = `${env.APP_URL}/api/auth/saml/${slug}/acs`;

  let identity;
  try {
    identity = await verifyResponse(provider, samlResponse, expectedRequestId, callbackUrl);
  } catch (cause) {
    const detail = describeSamlError(cause);
    logger.warn(
      {
        provider: slug,
        err: safeErrorMessage(cause),
        saml_error: detail.name,
        saml_error_message: detail.message,
      },
      "saml.acs.verify-failed",
    );
    return failRedirect("saml-exchange-failed");
  }

  // Domain gate + auto-provision. Mirrors the OIDC callback shape so the
  // operator experience is identical.
  let user = await findUserByEmail(identity.email);
  if (!user) {
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
        "saml.acs.provisioning-rejected",
      );
      return failRedirect("saml-not-authorized");
    }

    user = await insertUser({
      email: identity.email,
      name: identity.name ?? null,
      // SAML has no `email_verified` analogue — we treat the IdP's
      // attestation as trust by default. Operators that don't trust the IdP
      // should restrict it via the per-provider email-domain allow-list.
      emailVerifiedAt: new Date(),
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

  // Compute the IdP-derived permission set for this sign-in (#85). The
  // result is persisted onto the session row in `startSession`.
  let derivedPermissions: Awaited<ReturnType<typeof computeGroupSync>>["derived"] = [];
  if (provider.groupMappings && provider.groupMappings.length > 0) {
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
        "saml.acs.group-sync-failed",
      );
    }
  }

  await startSession({
    userId: user.id,
    ip: ip ?? null,
    userAgent,
    derivedPermissions,
    idp: { type: "saml", slug: provider.slug },
    // We repurpose the OIDC logout slots: endSessionUrl = IdP SLO URL,
    // idToken = NameID, clientId = sessionIndex. The logout handler reads
    // these to build a SAML LogoutRequest. Documented in lib/auth/providers/saml.ts.
    ...(identity.oidcLogout
      ? {
          oidc: {
            endSessionUrl: identity.oidcLogout.endSessionUrl,
            idToken: identity.oidcLogout.idToken,
            clientId: identity.oidcLogout.clientId,
          },
        }
      : {}),
  });

  await appendAudit({
    actor: { type: "user", id: user.id },
    action: "auth.login.success",
    resource: { type: "user", id: user.id },
    after: { source: identity.source, method: "saml" },
    request: { ip, userAgent, requestId: getRequestId(hdrs) },
  });

  logger.info(
    { userId: user.id, source: identity.source, requestId: getRequestId(hdrs) },
    "auth.saml.success",
  );

  return Response.redirect(`${env.APP_URL}${safeNextPath(nextFromCookie)}`, 302);
}
