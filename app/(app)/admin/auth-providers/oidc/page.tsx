/**
 * app/(app)/admin/oidc-providers/page.tsx
 *
 * Backward-compat redirect. The OIDC provider list lived here historically;
 * it now lives at /admin/authentication alongside Local Auth (and, when PR 2
 * + PR 3 of `feat/auth-providers-ldap-saml-webauthn` land, SAML and LDAP).
 * Bookmarks and audit-log links to this path keep working.
 *
 * The per-provider edit pages (./[id], ./new) keep their existing URLs —
 * only the index moved.
 */

import { redirect } from "next/navigation";

export default function OidcProvidersListPageRedirect(): never {
  redirect("/admin/authentication");
}
