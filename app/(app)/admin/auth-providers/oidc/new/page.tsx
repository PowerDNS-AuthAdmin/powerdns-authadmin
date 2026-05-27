/**
 * app/(app)/admin/oidc-providers/new/page.tsx
 *
 * Backward-compat redirect. The "add provider" flow moved to
 * `/admin/authentication/new` so the picker (OIDC / SAML / LDAP) renders
 * BEFORE the protocol-specific form. Bookmarks + audit-log links that
 * still point here keep working and land on the OIDC-typed branch of
 * the new flow.
 */

import { redirect } from "next/navigation";

export default function NewOidcProviderRedirect(): never {
  redirect("/admin/authentication/new?type=oidc");
}
