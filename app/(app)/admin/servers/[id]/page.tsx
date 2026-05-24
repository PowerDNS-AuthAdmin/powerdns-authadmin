/**
 * app/(app)/admin/servers/[id]/page.tsx
 *
 * Edit (and delete + test) a single PowerDNS backend. Permission-gated by
 * `server.update`. The form re-uses the shared `ServerForm`; delete + test
 * controls are in `ServerActions`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findPdnsServerById, listSecondariesForPrimary } from "@/lib/db/repositories/pdns-servers";
import { listAllClusters } from "@/lib/db/repositories/pdns-clusters";
import { latestServerAdminEdit, recentAdminEditsForServer } from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { isWriteCapable, summarizeCapabilities } from "@/lib/pdns/capabilities";
import { type SafeConfigRow } from "@/lib/pdns/config-advice";
import { readDaemonConfig } from "@/lib/pdns/daemon-config-cache";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { backendUnreachability } from "@/lib/realtime/backend-status";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { PdnsConfView } from "@/components/domain/pdns-conf-view";
import { ServerForm } from "../_components/server-form";
import { ServerActions } from "../_components/server-actions";

export const metadata: Metadata = { title: "Edit PowerDNS server" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPdnsServerPage({ params }: PageProps) {
  const { ability } = await requireUserForPage({ can: "server.update" });
  const { id } = await params;
  const row = await findPdnsServerById(id);
  if (!row) notFound();

  // Groups the operator can place this backend in — populates the form's
  // optional "Group" picker (ADR-0014).
  const groups = (await listAllClusters()).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
  }));

  // For primaries, list the secondaries that share its group — surfaced as a
  // section beneath the form so operators can see the mirror set inline.
  const secondaries = isWriteCapable(row.capabilities) ? await listSecondariesForPrimary(row) : [];

  // Audit-derived last-edit line. Gated by audit.read since it
  // leaks "X did Y at Z time" — matches the zone-detail page
  // convention.
  const canReadAudit = ability.can("read", "Audit");
  const [lastEdit, recentEdits] = canReadAudit
    ? await Promise.all([latestServerAdminEdit(row.id), recentAdminEditsForServer(row.id, 10)])
    : [null, []];
  // Ask the broker to ensure a recent observation, then read the shared store —
  // same source as the servers list + bell, so all three agree. No PDNS call
  // from this page.
  await ensureBackendsObserved();
  // Reachability from the live status store; `lastSeenAt` only supplies the
  // "last contact" label for a reachable backend.
  const reachability: "down" | "auth" | null = backendUnreachability(row.id);
  const reachFresh = row.lastSeenAt ? freshnessOf(row.lastSeenAt.toISOString()) : null;

  // Read-only daemon config for the "Daemon configuration" section, served from
  // the broker's display-safe config cache (allowlisted, secret-stripped — the
  // poll populated it). Capability-vs-config advisories live in the health bell
  // (ADR-0015), not here.
  const daemonSettings: SafeConfigRow[] =
    row.disabledAt === null ? (readDaemonConfig(row.id) ?? []) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{row.name}</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          {row.disabledAt ? (
            <>Disabled.</>
          ) : reachability === "auth" ? (
            <span className="text-[color:var(--color-error)]">
              API rejected the key — check the X-API-Key and the webserver/api ACL.
            </span>
          ) : reachability === "down" ? (
            <span className="text-[color:var(--color-error)]">
              Unreachable — the app hasn&apos;t reached this backend&apos;s API recently.
            </span>
          ) : reachFresh ? (
            <>
              Reachable · {reachFresh.label} — PDNS {row.versionCache?.version ?? "?"}.
            </>
          ) : (
            <>Not yet reached.</>
          )}
        </p>
        {row.capabilities ? (
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            <span className="font-medium text-[color:var(--color-fg)]">Observed:</span>{" "}
            {summarizeCapabilities(row.capabilities)}
            {row.capabilities.backends.length > 0 ? (
              <> · {row.capabilities.backends.join(", ")}</>
            ) : null}
            {row.capabilities.dnssec ? <> · DNSSEC</> : null}
          </p>
        ) : null}
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
              <>No admin edits recorded yet for this server.</>
            )}
          </p>
        ) : null}
      </header>

      <ServerForm
        mode="edit"
        groups={groups}
        initial={{
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description ?? "",
          baseUrl: row.baseUrl,
          serverId: row.serverId,
          isDefault: row.isDefault,
          disabled: row.disabledAt !== null,
          clusterId: row.clusterId,
          advertisedAddresses: row.advertisedAddresses,
        }}
      />

      {daemonSettings.length > 0 ? (
        <section className="rounded-md border border-[color:var(--color-border)] p-4">
          <header className="mb-3">
            <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              Daemon configuration
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
              Read-only, from the server&apos;s <code>/config</code>. PowerDNS settings are
              file-based — change them in <code>pdns.conf</code>, not here. Secrets are redacted.
            </p>
          </header>
          <PdnsConfView rows={daemonSettings} />
        </section>
      ) : null}

      {isWriteCapable(row.capabilities) ? (
        <section className="rounded-md border border-[color:var(--color-border)] p-4">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                Secondaries ({secondaries.length})
              </h2>
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                Read-only mirrors sharing this primary&apos;s group — polled for stats + sync state.
              </p>
            </div>
            <Link
              href={
                row.clusterId
                  ? `/admin/servers/new?group=${encodeURIComponent(row.clusterId)}`
                  : "/admin/servers/new"
              }
              className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
            >
              + Add secondary
            </Link>
          </header>
          {secondaries.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              {row.clusterId
                ? "No secondaries in this group yet. Add one to enable sync-status checks + per-server stat graphs."
                : "Put this primary in a group (above), then add secondaries to that group to enable sync-status checks."}
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)] text-sm">
              {secondaries.map((s) => (
                <li key={s.id} className="flex items-baseline justify-between py-2">
                  <div>
                    <Link
                      href={`/admin/servers/${s.id}`}
                      className="font-medium text-[color:var(--color-accent)] hover:underline"
                    >
                      {s.name}
                    </Link>
                    <span className="ml-2 text-xs text-[color:var(--color-fg-muted)]">
                      {s.slug} · {s.baseUrl}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {canReadAudit ? (
        <>
          <AdminAuditPanel
            entries={recentEdits}
            fullHistoryHref={`/admin/audit?resourceType=pdns_server&resourceId=${encodeURIComponent(row.id)}`}
          />
          {/* Deep-link to the raw HTTP-request log filtered to this
              backend. Audit log captures who/what; the requests log
              captures the actual wire traffic. Two complementary views. */}
          <p className="text-xs">
            <Link
              href={`/admin/pdns-requests?serverSlug=${encodeURIComponent(row.slug)}`}
              className="text-[color:var(--color-accent)] hover:underline"
            >
              View PowerDNS HTTP requests for this server →
            </Link>
          </p>
        </>
      ) : null}

      <ServerActions id={row.id} />
    </div>
  );
}
