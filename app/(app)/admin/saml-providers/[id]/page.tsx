/**
 * app/(app)/admin/saml-providers/[id]/page.tsx
 *
 * Edit / delete page for a SAML provider. Mirrors the OIDC equivalent
 * (`/admin/oidc-providers/[id]/page.tsx`): pickers + audit panel + danger zone.
 */

import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findSamlProviderById } from "@/lib/db/repositories/saml-providers";
import {
  latestSamlProviderEdit,
  recentAdminEditsForSamlProvider,
} from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { SamlProviderForm } from "../_components/saml-provider-form";
import { SamlProviderActions } from "../_components/saml-provider-actions";

export default async function SamlProviderEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { ability } = await requireUserForPage({ can: "oidc.read" });
  const canManage = ability.can("manage", "Oidc");
  const { id } = await params;

  const provider = await findSamlProviderById(id);
  if (!provider) notFound();

  const canReadAudit = ability.can("read", "Audit");
  const [lastEdit, recentEdits] = canReadAudit
    ? await Promise.all([
        latestSamlProviderEdit(provider.id),
        recentAdminEditsForSamlProvider(provider.id, 10),
      ])
    : [null, []];

  const [pickerRoles, pickerTeams, pickerServers] = await Promise.all([
    listRoles(),
    listAllTeams(),
    listAllPdnsServers(),
  ]);

  // The signature algorithm is a "sha1" | "sha256" | "sha512" enum in the
  // form type but the DB column is a free `text` (for forward compat with
  // any future algos). Narrow defensively — anything else falls back to the
  // recommended default.
  const safeSigAlg = (
    ["sha1", "sha256", "sha512"].includes(provider.signatureAlgorithm)
      ? provider.signatureAlgorithm
      : "sha256"
  ) as "sha1" | "sha256" | "sha512";

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
          SP metadata:{" "}
          <a
            href={`/api/auth/saml/${provider.slug}/metadata`}
            className="underline"
            target="_blank"
            rel="noreferrer noopener"
          >
            /api/auth/saml/{provider.slug}/metadata
          </a>{" "}
          — paste this URL into your IdP&apos;s SP registration form.
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

      <SamlProviderForm
        mode="edit"
        initial={{
          id: provider.id,
          slug: provider.slug,
          name: provider.name,
          idpEntityId: provider.idpEntityId,
          idpSsoUrl: provider.idpSsoUrl,
          idpSloUrl: provider.idpSloUrl ?? "",
          idpSigningCert: provider.idpSigningCert,
          spSigningCert: provider.spSigningCert,
          hasEncryptionPair: provider.spEncryptionCert !== null,
          spEncryptionCert: provider.spEncryptionCert ?? "",
          requireSignedResponse: provider.requireSignedResponse,
          requireEncryptedAssertion: provider.requireEncryptedAssertion,
          signatureAlgorithm: safeSigAlg,
          nameIdFormat: provider.nameIdFormat,
          claimEmail: provider.claimEmail,
          claimName: provider.claimName,
          claimGroups: provider.claimGroups,
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

      {canReadAudit ? (
        <AdminAuditPanel
          entries={recentEdits}
          fullHistoryHref={`/admin/audit?resourceType=saml_provider&resourceId=${encodeURIComponent(provider.id)}`}
        />
      ) : null}

      {canManage ? (
        <section className="mt-12 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/5 p-4">
          <h2 className="text-base font-medium text-[color:var(--color-error)]">Danger zone</h2>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Deleting this provider removes it from the login page immediately. In-flight sign-ins
            fail with <code>saml-unknown-provider</code>. Audit history is preserved.
          </p>
          <SamlProviderActions id={provider.id} name={provider.name} />
        </section>
      ) : null}
    </div>
  );
}
