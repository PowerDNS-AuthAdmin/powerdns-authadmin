/**
 * app/api/auth/saml/[slug]/slo/route.ts
 *
 * GET /api/auth/saml/<slug>/slo
 *
 * Single-logout endpoint. We end the local session (revoke the row + clear
 * the cookie) and set the `pda_just_logged_out` cookie the OIDC SLO flow
 * also sets - the login page reads it to suppress the "auto-redirect to
 * default provider" behavior on the post-logout visit.
 *
 * IdP-initiated SLO (the IdP signs a LogoutRequest and POSTs it here) is
 * left as a follow-up - the current path covers SP-initiated SLO via the
 * logout link on the user menu.
 */

import { cookies, headers } from "next/headers";
import { env, isProduction } from "@/lib/env";
import { resolveSamlProvider } from "@/lib/auth/providers/saml";
import { endSession, readSession } from "@/lib/auth/session";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const provider = await resolveSamlProvider(slug);
  if (!provider) {
    return Response.redirect(`${env.APP_URL}/login`, 302);
  }

  // Audit before the session row disappears (mirrors /api/auth/logout).
  const session = await readSession();
  const hdrs = await headers();
  await appendAudit({
    actor: { type: "user", id: session?.userId ?? null },
    action: "auth.logout",
    resource: { type: "session", id: session?.id ?? null },
    after: { rpInitiated: true, provider: slug, binding: "saml-slo" },
    request: getRequestContext(hdrs),
  });
  await endSession();

  // Mirror the OIDC SLO behavior: signal to /login that this visit is the
  // result of an explicit sign-out, so the default-provider auto-redirect
  // doesn't loop the user back into the IdP.
  const cookieStore = await cookies();
  cookieStore.set("pda_just_logged_out", "1", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 30,
  });

  const target = new URL(`${env.APP_URL}/login`);
  target.searchParams.set("signed-out", "1");
  return Response.redirect(target.toString(), 302);
}
