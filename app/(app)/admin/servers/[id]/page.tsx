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
import {
  findPdnsServerById,
  listActiveSecondariesForPrimary,
  listAllPrimaries,
} from "@/lib/db/repositories/pdns-servers";
import { latestServerAdminEdit, recentAdminEditsForServer } from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
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

  // Available primaries the operator can attach a secondary to. Used
  // by the form's "Mirrors which primary?" dropdown when role=secondary.
  const primaries = (await listAllPrimaries()).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
  }));

  // For primaries, list attached secondaries — surfaced as a section
  // beneath the form so operators can manage the mirror set inline.
  const secondaries = row.role === "primary" ? await listActiveSecondariesForPrimary(row.id) : [];

  // Audit-derived last-edit line. Gated by audit.read since it
  // leaks "X did Y at Z time" — matches the zone-detail page
  // convention.
  const canReadAudit = ability.can("read", "Audit");
  const [lastEdit, recentEdits] = canReadAudit
    ? await Promise.all([latestServerAdminEdit(row.id), recentAdminEditsForServer(row.id, 10)])
    : [null, []];
  const probeFresh = row.versionCache ? freshnessOf(row.versionCache.fetchedAt) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{row.name}</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          {probeFresh ? (
            <>
              Last probed {probeFresh.label} — PDNS {row.versionCache?.version ?? "?"}.
            </>
          ) : (
            <>Never probed.</>
          )}
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
              <>No admin edits recorded yet for this server.</>
            )}
          </p>
        ) : null}
      </header>

      <ServerForm
        mode="edit"
        primaries={primaries}
        initial={{
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description ?? "",
          baseUrl: row.baseUrl,
          serverId: row.serverId,
          isDefault: row.isDefault,
          disabled: row.disabledAt !== null,
          role: row.role,
          primaryId: row.primaryId,
        }}
      />

      {row.role === "primary" ? (
        <section className="rounded-md border border-[color:var(--color-border)] p-4">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                Secondaries ({secondaries.length})
              </h2>
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                Read-only mirrors of this primary — polled for stats + sync state.
              </p>
            </div>
            <Link
              href={`/admin/servers/new?secondaryOf=${encodeURIComponent(row.id)}`}
              className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
            >
              + Add secondary
            </Link>
          </header>
          {secondaries.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              No secondaries attached. Add one to enable sync-status checks + per-server stat
              graphs.
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
