/**
 * app/api/auth/oidc/[provider]/initiate/route.ts
 *
 * GET /api/auth/oidc/<slug>/initiate
 *
 * Kicks off the OIDC dance for the named provider. Builds the authorization
 * URL, stores `state`, the PKCE `code_verifier`, and the `nonce` in short-lived
 * HttpOnly cookies, and redirects to the IdP.
 *
 * The provider config is resolved via `lib/auth/providers/oidc.ts` —
 * `oidc_providers` table first, env fallback when no DB providers exist.
 */

import { cookies } from "next/headers";
import { isProduction, env } from "@/lib/env";
import { buildAuthorizationUrl, resolveOidcProvider } from "@/lib/auth/providers/oidc";

const OIDC_STATE_COOKIE = "pda_oidc_state";
const OIDC_PKCE_COOKIE = "pda_oidc_pkce";
const OIDC_NONCE_COOKIE = "pda_oidc_nonce";
const OIDC_SLUG_COOKIE = "pda_oidc_slug";
const OIDC_NEXT_COOKIE = "pda_oidc_next";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: slug } = await context.params;

  const provider = await resolveOidcProvider(slug);
  if (!provider) {
    return Response.json(
      { error: "Unknown OIDC provider." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const redirectUri = `${env.APP_URL}/api/auth/oidc/${provider.slug}/callback`;
  const { url, state, codeVerifier, nonce } = await buildAuthorizationUrl(provider, redirectUri);
  const cookieStore = await cookies();

  // All cookies are short-lived (10 min). The IdP round trip should be
  // far quicker; cookies expire if the user wanders off mid-flow.
  const tenMinutes = 60 * 10;
  const cookieOpts = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: tenMinutes,
  };
  cookieStore.set(OIDC_STATE_COOKIE, state, cookieOpts);
  cookieStore.set(OIDC_PKCE_COOKIE, codeVerifier, cookieOpts);
  // The callback echoes this back to openid-client as `expectedNonce` so the
  // library can confirm the ID token's `nonce` claim matches — replay defense.
  cookieStore.set(OIDC_NONCE_COOKIE, nonce, cookieOpts);
  // The callback handler reads this to know which provider it's continuing —
  // the route segment is already authoritative, but storing the slug
  // separately defends against URL tampering during the round-trip.
  cookieStore.set(OIDC_SLUG_COOKIE, provider.slug, cookieOpts);
  // Carry the attempted destination (L-2) across the IdP round-trip so the
  // callback can return the user there. Validated on read (callback).
  const next = new URL(request.url).searchParams.get("next");
  if (next) cookieStore.set(OIDC_NEXT_COOKIE, next, cookieOpts);

  return Response.redirect(url.toString(), 302);
}

export { OIDC_STATE_COOKIE, OIDC_PKCE_COOKIE, OIDC_NONCE_COOKIE, OIDC_SLUG_COOKIE };
