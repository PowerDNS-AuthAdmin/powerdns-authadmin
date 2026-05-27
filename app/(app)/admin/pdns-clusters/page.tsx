/**
 * app/(app)/admin/pdns-clusters/page.tsx
 *
 * Backward-compat redirect. The page moved to `/admin/clusters` when the
 * admin URL paths were aligned (the surrounding section is "PowerDNS",
 * so the "pdns-" prefix on the URL became redundant). Bookmarks and
 * audit-log links to the old path keep working.
 */

import { redirect } from "next/navigation";

export default function PdnsClustersRedirect(): never {
  redirect("/admin/clusters");
}
