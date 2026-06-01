/**
 * app/(app)/admin/ldap-providers/[id]/page.tsx
 *
 * Edit / delete page for an LDAP provider. Same shape as the OIDC edit page
 * but without the discovery-probe header (LDAP has no analogue of OIDC
 * discovery; the bind itself is the live health check, performed at
 * sign-in).
 */

import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findLdapProviderById } from "@/lib/db/repositories/ldap-providers";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { LdapProviderForm } from "../_components/ldap-provider-form";
import { LdapProviderActions } from "../_components/ldap-provider-actions";

export default async function LdapProviderEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { ability } = await requireUserForPage({ can: "auth.read" });
  const canManage = ability.can("manage", "Auth");
  const { id } = await params;

  const provider = await findLdapProviderById(id);
  if (!provider) notFound();

  const [pickerRoles, pickerTeams, pickerServers] = await Promise.all([
    listRoles(),
    listAllTeams(),
    listAllPdnsServers(),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{provider.name}</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          Slug{" "}
          <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{provider.slug}</code> -
          the slug can&apos;t be renamed (would break in-flight sign-ins).
        </p>
      </header>

      <LdapProviderForm
        mode="edit"
        initial={{
          id: provider.id,
          slug: provider.slug,
          name: provider.name,
          serverUrl: provider.serverUrl,
          startTls: provider.startTls,
          bindDn: provider.bindDn,
          userSearchBase: provider.userSearchBase,
          userSearchFilter: provider.userSearchFilter,
          groupSearchBase: provider.groupSearchBase,
          groupSearchFilter: provider.groupSearchFilter,
          groupAttr: provider.groupAttr,
          claimEmail: provider.claimEmail,
          claimName: provider.claimName,
          tlsCaCertSet: provider.tlsCaCert !== null,
          enabled: provider.enabled,
          allowedEmailDomains: provider.allowedEmailDomains,
          groupMappings: provider.groupMappings ?? [],
        }}
        canEdit={canManage}
        pickers={{
          roles: pickerRoles.map((r) => ({ slug: r.slug, name: r.name })),
          teams: pickerTeams.map((t) => ({ slug: t.slug, name: t.name })),
          servers: pickerServers.map((s) => ({ slug: s.slug, name: s.name })),
        }}
      />

      {canManage ? (
        <section className="mt-12 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/5 p-4">
          <h2 className="text-base font-medium text-[color:var(--color-error)]">Danger zone</h2>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Deleting this provider removes it from the login page immediately. In-flight sign-ins
            fail. Audit history is preserved.
          </p>
          <LdapProviderActions id={provider.id} name={provider.name} />
        </section>
      ) : null}
    </div>
  );
}
