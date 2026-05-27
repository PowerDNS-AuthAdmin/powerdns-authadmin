/**
 * Backward-compat redirect stub. LDAP admin moved to
 * `/admin/auth-providers/ldap` (#74).
 */

import { redirect } from "next/navigation";

export default function LdapProvidersIndexRedirect() {
  redirect("/admin/auth-providers/ldap");
}
