/**
 * app/api/auth/saml/[slug]/metadata/route.ts
 *
 * GET /api/auth/saml/<slug>/metadata
 *
 * Returns the SP metadata XML that operators paste into their IdP. Includes
 * the signing cert (always) and the encryption cert (when configured), the
 * ACS endpoint, the SLO endpoint, and the requested NameID format.
 *
 * Returned with `Content-Type: application/samlmetadata+xml` per the SAML
 * Metadata for the OASIS Security Assertion Markup Language spec.
 */

import { env } from "@/lib/env";
import { buildSpMetadata, resolveSamlProvider } from "@/lib/auth/providers/saml";

export async function GET(
  _request: Request,
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
  const xml = buildSpMetadata(provider, env.APP_URL);
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/samlmetadata+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
