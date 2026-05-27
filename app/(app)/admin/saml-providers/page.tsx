/**
 * Backward-compat redirect stub. SAML admin moved to
 * `/admin/auth-providers/saml` (#74).
 */

import { redirect } from "next/navigation";

export default function SamlProvidersIndexRedirect() {
  redirect("/admin/auth-providers/saml");
}
