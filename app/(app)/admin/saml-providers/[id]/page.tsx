import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SamlProviderRedirect({ params }: PageProps) {
  const { id } = await params;
  redirect(`/admin/auth-providers/saml/${encodeURIComponent(id)}`);
}
