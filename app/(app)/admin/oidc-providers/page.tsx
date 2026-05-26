/**
 * app/(app)/admin/oidc-providers/page.tsx
 *
 * List view for OIDC identity providers. A provider configured via `OIDC_*`
 * environment variables appears here as a READ-ONLY row badged "Configured by
 * ENV", alongside DB-backed providers — not as a hidden fallback. It's edited
 * by changing env vars, not from the UI; a DB provider with the same slug
 * shadows it.
 */

import Link from "next/link";
import { env } from "@/lib/env";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listAllOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { envOidcProviderSummary, type EnvOidcProviderSummary } from "@/lib/auth/providers/oidc";
import { latestAdminEditTimestampsForOidcProviders } from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { probeFailureLabel, type ProbeFailureReason } from "@/lib/auth/providers/oidc-probe";
import { ensureFreshOidcDiscovery } from "@/lib/auth/providers/oidc-discovery-sampler";
import { logger } from "@/lib/logger";
import { TestDiscoveryButton } from "./_components/test-discovery-button";
import { RefreshAllButton } from "./_components/refresh-all-button";

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
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left">
              <tr>
                <Th />
                <Th>Name</Th>
                <Th>Slug</Th>
                <Th>Issuer</Th>
                <Th>Enabled</Th>
                <Th>Domains</Th>
                <Th>Discovery</Th>
                {canReadAudit ? <Th>Last admin edit</Th> : null}
                <Th />
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr
                  key={p.id}
                  className={`border-t border-[color:var(--color-border)] ${rowAttentionClass(
                    p.enabled,
                    p.discoveryCache,
                  )}`}
                >
                  <Td>
                    {p.iconUrl ? (
                      // Operator-supplied icon — same trust as the
                      // brand_logo_url surface. CSP `img-src` allows
                      // https + data:. Sized to the row.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.iconUrl}
                        alt=""
                        style={{
                          width: 20,
                          height: 20,
                          objectFit: "contain",
                          display: "block",
                        }}
                      />
                    ) : (
                      <span
                        className="block h-5 w-5 rounded bg-[color:var(--color-bg-muted)]"
                        title="No icon set"
                      />
                    )}
                  </Td>
                  <Td>{p.name}</Td>
                  <Td>
                    <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{p.slug}</code>
                  </Td>
                  <Td className="text-[color:var(--color-fg-muted)]">{p.issuerUrl}</Td>
                  <Td>
                    {p.enabled ? (
                      <span className="rounded-full bg-[color:var(--color-success)]/15 px-2 py-0.5 text-xs">
                        Yes
                      </span>
                    ) : (
                      <span className="rounded-full bg-[color:var(--color-fg-muted)]/15 px-2 py-0.5 text-xs">
                        No
                      </span>
                    )}
                  </Td>
                  <Td>
                    <DomainsCell allowedEmailDomains={p.allowedEmailDomains} />
                  </Td>
                  <Td>
                    <DiscoveryBadge discoveryCache={p.discoveryCache} />
                  </Td>
                  {canReadAudit ? (
                    <Td className="text-xs text-[color:var(--color-fg-muted)]">
                      {lastEdits.has(p.id) ? (
                        <span title={lastEdits.get(p.id)!.toISOString()}>
                          {freshnessOf(lastEdits.get(p.id)!.toISOString()).label}
                        </span>
                      ) : (
                        "—"
                      )}
                    </Td>
                  ) : null}
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <TestDiscoveryButton providerId={p.id} />
                      <Link href={`/admin/oidc-providers/${p.id}`} className="text-sm underline">
                        {canManage ? "Edit" : "View"}
                      </Link>
                    </span>
                  </Td>
                </tr>
              ))}
              {showEnvRow && envProvider ? (
                <EnvProviderRow provider={envProvider} canReadAudit={canReadAudit} />
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only row for the env-configured provider. It isn't a DB row, so it
 * carries no edit/test/audit affordances — just the "Configured by ENV" badge
 * making clear it's driven by `OIDC_*` and changed by editing env vars. The
 * env provider has no group→role mapping and no discovery probe.
 */
function EnvProviderRow({
  provider,
  canReadAudit,
}: {
  provider: EnvOidcProviderSummary;
  canReadAudit: boolean;
}) {
  return (
    <tr className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]/40">
      <Td>
        <span
          className="block h-5 w-5 rounded bg-[color:var(--color-bg-muted)]"
          title="No icon (env provider)"
        />
      </Td>
      <Td>
        <span className="inline-flex items-center gap-2">
          {provider.name}
          <span
            className="rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-muted)] px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase"
            title="Configured via OIDC_* environment variables. Edit by changing env vars, not the UI."
          >
            Configured by ENV
          </span>
        </span>
      </Td>
      <Td>
        <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{provider.slug}</code>
      </Td>
      <Td className="text-[color:var(--color-fg-muted)]">{provider.issuerUrl}</Td>
      <Td>
        <span className="rounded-full bg-[color:var(--color-success)]/15 px-2 py-0.5 text-xs">
          Yes
        </span>
      </Td>
      <Td>
        <DomainsCell allowedEmailDomains={provider.allowedEmailDomains} />
      </Td>
      <Td className="text-xs text-[color:var(--color-fg-muted)]">—</Td>
      {canReadAudit ? <Td className="text-xs text-[color:var(--color-fg-muted)]">—</Td> : null}
      <Td>
        <span
          className="text-xs text-[color:var(--color-fg-muted)]"
          title="Read-only — edit via OIDC_* environment variables"
        >
          Read-only
        </span>
      </Td>
    </tr>
  );
}

/**
 * Per-row attention class. Enabled providers that are
 * either never-probed or failing get a left-edge accent + subtle
 * tinted background, matching the dashboard attention widget
 * (T-104) tones — operators arriving from the widget's tile can
 * eyeball which row(s) caused it to fire instead of reading the
 * Discovery column on every row.
 *
 * Disabled providers stay neutral (operator-intentional, not
 * actionable). Same gating logic as `oidcAttentionCounts` so the
 * row highlight and the dashboard count never disagree.
 *
 * The classes use the project's color tokens directly — kept in
 * one place so the visual vocabulary stays cross-page consistent.
 */
function rowAttentionClass(
  enabled: boolean,
  cache: { fetchedAt: string; ok: boolean; reason?: string } | null,
): string {
  if (!enabled) return "";
  if (cache === null) {
    // Never probed — warn tone (could be fresh + healthy; just
    // hasn't been checked yet).
    return "bg-[color:var(--color-warn)]/5 border-l-2 border-l-[color:var(--color-warn)]";
  }
  if (!cache.ok) {
    // Active failure — error tone.
    return "bg-[color:var(--color-error)]/5 border-l-2 border-l-[color:var(--color-error)]";
  }
  return "";
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 text-xs font-medium tracking-wide uppercase">{children}</th>;
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ""}`}>{children}</td>;
}

/**
 * Three-state renderer for the per-provider email-domain allow-list
 * (S-7 / Ticks 43-44). Matches the resolver semantics in
 * `lib/auth/email-domain-allowlist.ts`:
 *
 *   null       → "(inherited)"  — env default applies
 *   []         → "(unrestricted)" — explicit override of env
 *   [a, b, …]  → "N domain(s)" with the list as a tooltip
 */
function DomainsCell({ allowedEmailDomains }: { allowedEmailDomains: string[] | null }) {
  if (allowedEmailDomains === null) {
    return (
      <span
        className="text-[color:var(--color-fg-muted)]"
        title="Inherits OIDC_ALLOWED_EMAIL_DOMAINS from env."
      >
        (inherited)
      </span>
    );
  }
  if (allowedEmailDomains.length === 0) {
    return (
      <span
        className="text-[color:var(--color-fg-muted)]"
        title="Override: no restriction at this provider."
      >
        (unrestricted)
      </span>
    );
  }
  return (
    <span title={allowedEmailDomains.join(", ")}>
      {allowedEmailDomains.length} domain{allowedEmailDomains.length === 1 ? "" : "s"}
    </span>
  );
}

/**
 * Health badge for the cached discovery probe. Three
 * states matching the resource semantics elsewhere:
 *   - null cache (never probed) → muted "(not yet probed)"
 *   - cache.ok=true → green dot + "Reachable · Nm ago"
 *     (freshness label via `freshnessOf`, same time-language as
 *     /admin/servers and /zones).
 *   - cache.ok=false → red dot + "Failed · Nm ago" + tooltip with
 *     the human-readable reason.
 */
function DiscoveryBadge({
  discoveryCache,
}: {
  discoveryCache: { fetchedAt: string; ok: boolean; reason?: string } | null;
}) {
  if (!discoveryCache) {
    return (
      <span
        className="text-xs text-[color:var(--color-fg-muted)]"
        title="Click Test to probe the issuer's discovery endpoint."
      >
        (not yet probed)
      </span>
    );
  }
  const fresh = freshnessOf(discoveryCache.fetchedAt);
  if (discoveryCache.ok) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-success)]" />
        Reachable
        <span className="text-[color:var(--color-fg-muted)]">· {fresh.label}</span>
      </span>
    );
  }
  // Failure: tooltip carries the human-readable hint so operators
  // don't have to dig into the audit log for the reason.
  const reason = discoveryCache.reason as ProbeFailureReason | undefined;
  const hint = reason ? probeFailureLabel(reason) : "Discovery probe failed.";
  return (
    <span className="inline-flex items-center gap-1 text-xs" title={hint}>
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-error)]" />
      Failed
      <span className="text-[color:var(--color-fg-muted)]">· {fresh.label}</span>
    </span>
  );
}
