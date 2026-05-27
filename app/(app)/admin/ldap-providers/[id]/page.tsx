import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LdapProviderRedirect({ params }: PageProps) {
  const { id } = await params;
  redirect(`/admin/auth-providers/ldap/${encodeURIComponent(id)}`);
}
