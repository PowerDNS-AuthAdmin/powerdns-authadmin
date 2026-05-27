/**
 * app/(app)/admin/pdns-requests/page.tsx
 *
 * Backward-compat redirect. The page moved to `/admin/requests` when the
 * admin URL paths were aligned. Bookmarks and audit-log links to the
 * old path keep working.
 */

import { redirect } from "next/navigation";

export default function PdnsRequestsRedirect(): never {
  redirect("/admin/requests");
}
