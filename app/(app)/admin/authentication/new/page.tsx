/**
 * app/(app)/admin/authentication/new/page.tsx
 *
 * Add-a-provider entry point. Renders a type picker (OIDC / SAML / LDAP)
 * with the relevant configuration form unhidden once a type is chosen.
 *
 * Server component because the OIDC group-mapping picker needs the role /
 * team / server lists at first paint (operators get autocomplete-quality
 * dropdowns without a runtime fetch round-trip). The actual type-toggle +
 * form switch lives in the client wrapper (`./_components/new-provider-client`).
 *
 * Permission: `oidc.manage` — even though SAML and LDAP aren't built yet,
 * those will gate on the same provider-management permission. Operators
 * without it can't reach this page at all.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { NewProviderClient } from "../_components/new-provider-client";

export const metadata: Metadata = { title: "Add provider" };

export default async function NewAuthProviderPage() {
  await requireUserForPage({ can: "oidc.manage" });
  const [roles, teams, servers] = await Promise.all([
    listRoles(),
    listAllTeams(),
    listAllPdnsServers(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/admin/authentication"
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          ← Back to Authentication
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add provider</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Choose what kind of identity provider you're adding. The form below changes to match.
        </p>
      </header>

      <NewProviderClient
        pickers={{
          roles: roles.map((r) => ({ slug: r.slug, name: r.name })),
          teams: teams.map((t) => ({ slug: t.slug, name: t.name })),
          servers: servers.map((s) => ({ slug: s.slug, name: s.name })),
        }}
      />
    </div>
  );
}
