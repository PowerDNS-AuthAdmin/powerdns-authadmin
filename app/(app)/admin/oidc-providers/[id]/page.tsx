/**
 * Backward-compat redirect stub. See ../page.tsx for rationale.
 */

import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function OidcProviderRedirect({ params }: PageProps) {
  const { id } = await params;
  redirect(`/admin/auth-providers/oidc/${encodeURIComponent(id)}`);
}
