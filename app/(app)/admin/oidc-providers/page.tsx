/**
 * app/(app)/admin/oidc-providers/page.tsx
 *
 * List view for OIDC identity providers. A provider configured via `OIDC_*`
 * environment variables appears here as a READ-ONLY row badged "Configured by
 * ENV", alongside DB-backed providers — not as a hidden fallback. It's edited
 * by changing env vars, not from the UI; a DB provider with the same slug
 * shadows it.
 */

import { env } from "@/lib/env";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listAllOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { envOidcProviderSummary } from "@/lib/auth/providers/oidc";
import { latestAdminEditTimestampsForOidcProviders } from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { probeFailureLabel, type ProbeFailureReason } from "@/lib/auth/providers/oidc-probe";
import { ensureFreshOidcDiscovery } from "@/lib/auth/providers/oidc-discovery-sampler";
import { logger } from "@/lib/logger";
import { RefreshAllButton } from "./_components/refresh-all-button";
import { OidcProvidersTable, type OidcProviderRow } from "./_components/oidc-providers-table";

export default async function OidcProvidersPage() {
  const { ability } = await requireUserForPage({ can: "oidc.read" });
  const canManage = ability.can("manage", "Oidc");
  const canReadAudit = ability.can("read", "Audit");

  // opportunistic discovery refresh. Best-effort —
  // failures here must not stall the page render (the function is
  // already defensive internally; this catch is a final safety net
  // for unexpected DB or import-time errors). 15-minute staleness
  // gate inside means the page only pays the probe cost
  // occasionally, and probes run in parallel so worst-case wait is
  // one ~5s timeout, not N × that.
  try {
    await ensureFreshOidcDiscovery();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "unknown" },
      "oidc.discovery.ensureFresh.failed",
    );
  }

  const providers = await listAllOidcProviders();
  const lastEdits =
    canReadAudit && providers.length > 0
      ? await latestAdminEditTimestampsForOidcProviders(providers.map((p) => p.id))
      : new Map<string, Date>();
  // The env-configured provider is shown as a read-only row alongside DB
  // providers, unless a DB provider already claims its slug (which shadows it).
  const envProvider = envOidcProviderSummary();
  const envShadowed = envProvider !== null && providers.some((p) => p.slug === envProvider.slug);
  const showEnvRow = envProvider !== null && !envShadowed;
  const hasAnyRow = providers.length > 0 || showEnvRow;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OIDC providers</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Identity providers shown on the login page. The redirect URI registered with the IdP
            must be{" "}
            <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">
              {env.APP_URL}/api/auth/oidc/&lt;slug&gt;/callback
            </code>
            .
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 [&>*]:w-full sm:[&>*]:w-auto">
          {providers.length > 0 ? <RefreshAllButton /> : null}
          {canManage ? (
            <CreateButton href="/admin/oidc-providers/new" label="Add provider" />
          ) : null}
        </div>
      </header>

      {!hasAnyRow ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No providers configured yet.</p>
      ) : (
        <OidcProvidersTable
          rows={[
            ...providers.map<OidcProviderRow>((p) => {
              const lastEdit = lastEdits.get(p.id);
              const reason = p.discoveryCache?.reason as ProbeFailureReason | undefined;
              return {
                id: p.id,
                name: p.name,
                slug: p.slug,
                issuerUrl: p.issuerUrl,
                enabled: p.enabled,
                iconUrl: p.iconUrl,
                allowedEmailDomains: p.allowedEmailDomains,
                discoveryCache: p.discoveryCache,
                lastAdminEditLabel: lastEdit ? freshnessOf(lastEdit.toISOString()).label : null,
                lastAdminEditTitle: lastEdit ? lastEdit.toISOString() : null,
                discoveryFailHint: reason ? probeFailureLabel(reason) : null,
                isEnvManaged: false,
              };
            }),
            ...(showEnvRow && envProvider
              ? [
                  {
                    id: "",
                    name: envProvider.name,
                    slug: envProvider.slug,
                    issuerUrl: envProvider.issuerUrl,
                    enabled: true,
                    iconUrl: null,
                    allowedEmailDomains: envProvider.allowedEmailDomains,
                    discoveryCache: null,
                    lastAdminEditLabel: null,
                    lastAdminEditTitle: null,
                    discoveryFailHint: null,
                    isEnvManaged: true,
                  } satisfies OidcProviderRow,
                ]
              : []),
          ]}
          canManage={canManage}
          canReadAudit={canReadAudit}
        />
      )}
    </div>
  );
}
