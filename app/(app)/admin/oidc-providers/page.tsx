/**
 * app/(app)/admin/oidc-providers/page.tsx
 *
 * Backward-compat redirect stub. The OIDC admin lives at
 * `/admin/auth-providers/oidc` now that SAML + LDAP have joined it
 * under the unified parent (see #74). Bookmarks + the docs' older
 * `/admin/oidc-providers` URLs land here and get pushed forward.
 */

import { redirect } from "next/navigation";

export default function OidcProvidersIndexRedirect() {
  redirect("/admin/auth-providers/oidc");
}
