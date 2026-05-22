/**
 * app/(app)/admin/oidc-providers/[id]/page.tsx
 *
 * Edit / delete page for an OIDC provider.
 */

import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findOidcProviderById } from "@/lib/db/repositories/oidc-providers";
import {
  latestOidcProviderEdit,
  recentAdminEditsForOidcProvider,
} from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { probeFailureLabel, type ProbeFailureReason } from "@/lib/auth/providers/oidc-probe";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { OidcProviderForm } from "../_components/oidc-provider-form";
import { OidcProviderActions } from "../_components/oidc-provider-actions";
import { TestDiscoveryButton } from "../_components/test-discovery-button";

export default async function OidcProviderEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { ability } = await requireUserForPage({ can: "oidc.read" });
  const canManage = ability.can("manage", "Oidc");
  const { id } = await params;

  const provider = await findOidcProviderById(id);
  if (!provider) notFound();

  // Same pattern as the PDNS server detail page +
  // zone-detail: show probe age + last-admin-edit
  // line so operators see context without clicking around.
  const canReadAudit = ability.can("read", "Audit");
  const [lastEdit, recentEdits] = canReadAudit
    ? await Promise.all([
        latestOidcProviderEdit(provider.id),
        recentAdminEditsForOidcProvider(provider.id, 10),
      ])
    : [null, []];
  const probeFresh = provider.discoveryCache
    ? freshnessOf(provider.discoveryCache.fetchedAt)
    : null;

  // Pickers for the group-mappings editor — operators pick a role
  // by slug and a scope target (team / server / zone-name) without a
  // runtime fetch round-trip.
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
          <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{provider.slug}</code> —
          the slug can&apos;t be renamed (would break in-flight sign-ins).
        </p>
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          {probeFresh && provider.discoveryCache ? (
            provider.discoveryCache.ok ? (
              <>
                <span className="font-medium text-[color:var(--color-success)]">
                  Discovery: reachable
                </span>{" "}
                · probed {probeFresh.label}
              </>
            ) : (
              <>
                <span
                  className="font-medium text-[color:var(--color-error)]"
                  title={probeFailureLabel(provider.discoveryCache.reason as ProbeFailureReason)}
                >
                  Discovery: failed
                </span>{" "}
                · probed {probeFresh.label}
              </>
            )
          ) : (
            <>Discovery not yet probed. Click Test below to probe.</>
          )}{" "}
          <span className="ml-2 inline-block align-middle">
            <TestDiscoveryButton providerId={provider.id} />
          </span>
        </p>
        {canReadAudit ? (
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            {lastEdit ? (
              <>
                <span className="font-medium text-[color:var(--color-fg)]">Last admin edit:</span>{" "}
                {freshnessOf(lastEdit.ts.toISOString()).label}
                {lastEdit.actorEmail ? (
                  <>
                    {" by "}
                    <span className="font-mono">{lastEdit.actorEmail}</span>
                  </>
                ) : lastEdit.actorType === "system" ? (
                  <> by system</>
                ) : null}
                {" · action: "}
                <code className="rounded bg-[color:var(--color-bg-subtle)] px-1 text-[0.625rem]">
                  {lastEdit.action}
                </code>
              </>
            ) : (
              <>No admin edits recorded yet.</>
            )}
          </p>
        ) : null}
      </header>

      <OidcProviderForm
        mode="edit"
        initial={{
          id: provider.id,
          slug: provider.slug,
          name: provider.name,
          issuerUrl: provider.issuerUrl,
          clientId: provider.clientId,
          scopes: provider.scopes,
          claimEmail: provider.claimEmail,
          claimName: provider.claimName,
          enabled: provider.enabled,
          forceDefault: provider.forceDefault,
          requireEmailVerified: provider.requireEmailVerified,
          allowedEmailDomains: provider.allowedEmailDomains,
          iconUrl: provider.iconUrl,
          groupMappings: provider.groupMappings ?? [],
        }}
        canEdit={canManage}
        pickers={{
          roles: pickerRoles.map((r) => ({ slug: r.slug, name: r.name })),
          teams: pickerTeams.map((t) => ({ slug: t.slug, name: t.name })),
          servers: pickerServers.map((s) => ({ slug: s.slug, name: s.name })),
        }}
      />

      {canReadAudit ? (
        <AdminAuditPanel
          entries={recentEdits}
          fullHistoryHref={`/admin/audit?resourceType=oidc_provider&resourceId=${encodeURIComponent(provider.id)}`}
        />
      ) : null}

      {canManage ? (
        <section className="mt-12 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/5 p-4">
          <h2 className="text-base font-medium text-[color:var(--color-error)]">Danger zone</h2>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Deleting this provider removes it from the login page immediately. In-flight sign-ins
            fail with <code>oidc-unknown-provider</code>. Audit history is preserved.
          </p>
          <OidcProviderActions id={provider.id} name={provider.name} />
        </section>
      ) : null}
    </div>
  );
}
