/**
 * app/(app)/admin/oidc-providers/new/page.tsx
 *
 * Create form for a new OIDC provider. The client_secret is shown plaintext
 * once at creation — server stores its AES-256-GCM envelope, never returns
 * it again.
 */

import { requireUserForPage } from "@/lib/auth/require-user";
import { OidcProviderForm } from "../_components/oidc-provider-form";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";

export default async function NewOidcProviderPage() {
  await requireUserForPage({ can: "oidc.manage" });
  const [roles, teams, servers] = await Promise.all([
    listRoles(),
    listAllTeams(),
    listAllPdnsServers(),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add OIDC provider</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Configure an identity provider. Register the callback URL above with the IdP before
          saving.
        </p>
      </header>
      <OidcProviderForm
        mode="create"
        pickers={{
          roles: roles.map((r) => ({ slug: r.slug, name: r.name })),
          teams: teams.map((t) => ({ slug: t.slug, name: t.name })),
          servers: servers.map((s) => ({ slug: s.slug, name: s.name })),
        }}
      />
    </div>
  );
}
