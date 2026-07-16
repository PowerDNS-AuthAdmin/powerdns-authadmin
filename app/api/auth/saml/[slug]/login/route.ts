/**
 * app/api/auth/saml/[slug]/login/route.ts
 *
 * GET /api/auth/saml/<slug>/login
 *
 * Builds a signed AuthnRequest for the named SAML provider and redirects to
 * the IdP's SSO endpoint via the HTTP-Redirect binding. The expected RequestID
 * is stashed in a short-lived HttpOnly cookie so the ACS handler can verify
 * the inbound Response is one we asked for.
 */

import { cookies } from "next/headers";
import { isProduction, env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/redact";
import { buildAuthnRequest, resolveSamlProvider } from "@/lib/auth/providers/saml";

const SAML_STATE_COOKIE = "pda_saml_state";
const SAML_SLUG_COOKIE = "pda_saml_slug";
const SAML_NEXT_COOKIE = "pda_saml_next";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;

  const provider = await resolveSamlProvider(slug);
  if (!provider) {
    return Response.json(
      { error: "Unknown SAML provider." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const callbackUrl = `${env.APP_URL}/api/auth/saml/${provider.slug}/acs`;

  let redirectUrl: string;
  let requestId: string;
  try {
    const built = await buildAuthnRequest(provider, callbackUrl);
    redirectUrl = built.redirectUrl;
    requestId = built.requestId;
  } catch (err) {
    logger.warn(
      { provider: provider.slug, err: safeErrorMessage(err) },
      "saml.login.build-failure",
    );
    const target = new URL(`${env.APP_URL}/login`);
    target.searchParams.set("error", "saml-build-failed");
    return Response.redirect(target.toString(), 302);
  }

  const cookieStore = await cookies();
  const tenMinutes = 60 * 10;
  // SP-initiated SAML with the HTTP-POST binding returns via a cross-site POST
  // from the IdP to our ACS endpoint. A `SameSite=Lax` cookie is withheld on
  // that request, so the ACS handler sees no state cookie and fails with
  // `saml-state-missing`. The state must therefore ride `SameSite=None`, which
  // browsers only honour together with `Secure`. Over HTTPS (every real SAML
  // deployment, where APP_URL is https) that pairing is exact; on a plain-http
  // dev origin `Secure` would be dropped, so fall back to Lax there — a same-
  // site dev round-trip never needs the cross-site relaxation anyway.
  const httpsOrigin = env.APP_URL.startsWith("https:");
  const cookieOpts = {
    httpOnly: true,
    secure: httpsOrigin || isProduction,
    sameSite: httpsOrigin ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: tenMinutes,
  };
  cookieStore.set(SAML_STATE_COOKIE, requestId, cookieOpts);
  // The ACS reads this to confirm the URL slug wasn't tampered with mid-flow.
  cookieStore.set(SAML_SLUG_COOKIE, provider.slug, cookieOpts);
  // Carry attempted destination across the IdP round-trip (L-2). Validated in
  // the ACS handler before use.
  const next = new URL(request.url).searchParams.get("next");
  if (next) cookieStore.set(SAML_NEXT_COOKIE, next, cookieOpts);

  return Response.redirect(redirectUrl, 302);
}

export { SAML_STATE_COOKIE, SAML_SLUG_COOKIE, SAML_NEXT_COOKIE };
