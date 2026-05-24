/**
 * app/(app)/admin/servers/page.tsx
 *
 * Lists every PowerDNS backend the operator has configured, with a quick
 * health badge per row driven by `last_seen_at` — the last time the
 * background poller (or a manual probe) successfully reached the backend.
 *
 * Permission: `server.read`. The "Add server" / row delete / row test
 * actions are additionally gated by `server.create`, `server.delete`,
 * `server.update` in the routes they post to.
 */

import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { latestAdminEditTimestampsForServers } from "@/lib/db/repositories/audit-log";
import { freshnessOf } from "@/lib/freshness";
import { rawCache } from "@/lib/pdns/zone-state-cache";
import { derivedParentOf } from "@/lib/pdns/topology-cache";
import { isReadOnlyMirror, summarizeCapabilities } from "@/lib/pdns/capabilities";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { backendUnreachability } from "@/lib/realtime/backend-status";
import type { PdnsServer } from "@/lib/db/schema";
import { TestServerButton } from "./_components/test-server-button";
import { RefreshAllButton } from "./_components/refresh-all-button";
import { ServersPageHeartbeat } from "./_components/servers-page-heartbeat";

export const metadata: Metadata = { title: "PowerDNS servers" };

export default async function PdnsServersListPage() {
  const { ability } = await requireUserForPage({ can: "server.read" });
  const canCreate = ability.can("create", "Server");
  const canReadAudit = ability.can("read", "Audit");
  // Ask the broker to ensure a recent observation, then read its store — same
  // source the zones list + bell read, so the three never disagree.
  await ensureBackendsObserved();
  const servers = await listAllPdnsServers();
  const lastEdits =
    canReadAudit && servers.length > 0
      ? await latestAdminEditTimestampsForServers(servers.map((s) => s.id))
      : new Map<string, Date>();
  // Live reachability per backend from the shared status store (the single
  // source of truth for "reachable now"). Only down/auth entries are kept.
  const reachability = new Map<string, "down" | "auth">();
  for (const s of servers) {
    const u = backendUnreachability(s.id);
    if (u) reachability.set(s.id, u);
  }

  // Build a primary→secondaries tree (ADR-0014). A secondary nests under its
  // primary via EITHER explicit group membership OR the site-wide derived
  // topology (poller-computed from masters[]) — so an ungrouped secondary that
  // mirrors a managed primary still renders as its child, exactly as if grouped.
  // Two kinds of "loose" secondary sort to the bottom as their own sections so
  // they stay visible + editable:
  //   - standalone — mirrors an external/unmanaged primary, NOT an error;
  //   - orphaned — grouped but the group has no resolvable primary.
  const primaries = servers.filter((s) => !isReadOnlyMirror(s.capabilities));
  const primaryById = new Map(primaries.map((p) => [p.id, p]));
  // First write target of each group represents it in the tree (multi-primary
  // groups share storage, so any peer is an equivalent sync reference).
  const primaryByCluster = new Map<string, PdnsServer>();
  for (const p of primaries) {
    if (p.clusterId && !primaryByCluster.has(p.clusterId)) primaryByCluster.set(p.clusterId, p);
  }
  const secondariesByPrimary = new Map<string, PdnsServer[]>();
  const standaloneSecondaries: PdnsServer[] = [];
  const orphanSecondaries: PdnsServer[] = [];
  const nestUnder = (primaryId: string, s: PdnsServer): void => {
    const arr = secondariesByPrimary.get(primaryId) ?? [];
    arr.push(s);
    secondariesByPrimary.set(primaryId, arr);
  };
  for (const s of servers) {
    if (!isReadOnlyMirror(s.capabilities)) continue;
    // 1. Explicit group membership.
    const groupRep = s.clusterId ? primaryByCluster.get(s.clusterId) : undefined;
    if (groupRep) {
      nestUnder(groupRep.id, s);
      continue;
    }
    // 2. Derived parent from the site-wide topology (masters[]-based).
    const derivedParentId = derivedParentOf(s.id);
    const derivedParent = derivedParentId ? primaryById.get(derivedParentId) : undefined;
    if (derivedParent) {
      nestUnder(derivedParent.id, s);
      continue;
    }
    // 3. Loose: grouped-but-unresolved → orphan; otherwise standalone.
    if (s.clusterId) orphanSecondaries.push(s);
    else standaloneSecondaries.push(s);
  }

  // Precompute sync chips for secondaries off the zone-state cache —
  // never hits PDNS itself. "in sync" means every cached zone serial on
  // the secondary matches its primary's cached serial.
  const syncBySecondary = computeSecondarySync(primaries, secondariesByPrimary);
  let anyLagging = false;
  for (const verdict of syncBySecondary.values()) {
    if (verdict === "lagging") {
      anyLagging = true;
      break;
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PowerDNS servers</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            One row per upstream PowerDNS Authoritative backend.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {servers.some((s) => s.disabledAt === null) ? (
            <ServersPageHeartbeat inSync={!anyLagging} />
          ) : null}
          {servers.some((s) => s.disabledAt === null) ? <RefreshAllButton /> : null}
          {canCreate ? (
            <Link
              href="/admin/servers/new"
              className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
            >
              Add server
            </Link>
          ) : null}
        </div>
      </header>

      {servers.length === 0 ? (
        <EmptyState canCreate={canCreate} />
      ) : (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Base URL</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Version</th>
                <th className="px-4 py-2">Sync</th>
                {canReadAudit ? <th className="px-4 py-2">Last admin edit</th> : null}
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {primaries.map((primary) => {
                const kids = secondariesByPrimary.get(primary.id) ?? [];
                return (
                  <Fragment key={primary.id}>
                    <ServerRow
                      row={primary}
                      indented={false}
                      canReadAudit={canReadAudit}
                      lastEdits={lastEdits}
                      syncChip={null}
                      reachability={reachability.get(primary.id)}
                    />
                    {kids.map((s) => (
                      <ServerRow
                        key={s.id}
                        row={s}
                        indented={true}
                        canReadAudit={canReadAudit}
                        lastEdits={lastEdits}
                        syncChip={syncBySecondary.get(s.id) ?? null}
                        reachability={reachability.get(s.id)}
                      />
                    ))}
                  </Fragment>
                );
              })}
              {standaloneSecondaries.length > 0 ? (
                <Fragment>
                  <tr className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
                    <td
                      colSpan={canReadAudit ? 7 : 6}
                      className="px-4 py-1.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase"
                    >
                      Standalone secondaries (mirror an external / unmanaged primary)
                    </td>
                  </tr>
                  {standaloneSecondaries.map((s) => (
                    <ServerRow
                      key={s.id}
                      row={s}
                      indented={true}
                      canReadAudit={canReadAudit}
                      lastEdits={lastEdits}
                      syncChip={null}
                      reachability={reachability.get(s.id)}
                    />
                  ))}
                </Fragment>
              ) : null}
              {orphanSecondaries.length > 0 ? (
                <Fragment>
                  <tr className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
                    <td
                      colSpan={canReadAudit ? 7 : 6}
                      className="px-4 py-1.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase"
                    >
                      Orphan secondaries (parent disabled or deleted)
                    </td>
                  </tr>
                  {orphanSecondaries.map((s) => (
                    <ServerRow
                      key={s.id}
                      row={s}
                      indented={true}
                      canReadAudit={canReadAudit}
                      lastEdits={lastEdits}
                      syncChip={null}
                      reachability={reachability.get(s.id)}
                    />
                  ))}
                </Fragment>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Per-row attention tint, matching the row's status badge (and the dashboard
 * attention widget) off the live reachability store: unreachable/auth → error,
 * never-reached → warn, healthy/disabled → neutral. Keeping it on the same
 * signal as the badge means the tint and the badge can't disagree.
 */
function serverRowAttentionClass(
  disabledAt: Date | null,
  lastSeenAt: Date | null,
  reachability: "down" | "auth" | undefined,
): string {
  if (disabledAt) return "";
  if (reachability) {
    return "bg-[color:var(--color-error)]/5 border-l-2 border-l-[color:var(--color-error)]";
  }
  if (!lastSeenAt) {
    return "bg-[color:var(--color-warn)]/5 border-l-2 border-l-[color:var(--color-warn)]";
  }
  return "";
}

function EmptyState({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center">
      <p className="text-sm text-[color:var(--color-fg-muted)]">
        No PowerDNS servers configured yet.
        {canCreate ? " Add one to begin managing zones." : ""}
      </p>
      {canCreate ? (
        <Link
          href="/admin/servers/new"
          className="mt-4 inline-block rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Add your first server
        </Link>
      ) : null}
    </div>
  );
}

function HealthBadge({
  disabledAt,
  lastSeenAt,
  reachability,
}: {
  disabledAt: Date | null;
  lastSeenAt: Date | null;
  /** Live reachability from the advisory signal — same source as the bell. */
  reachability: "down" | "auth" | undefined;
}) {
  if (disabledAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-fg-subtle)]" />
        Disabled
      </span>
    );
  }
  // Live unreachable/auth state from the (debounced) advisory signal takes
  // precedence over the last-contact label — a backend the poller can no longer
  // reach must read red here exactly as it does in the bell, never a stale
  // "Reachable". Cleared the moment the poll reaches it again.
  if (reachability) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[color:var(--color-error)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-error)]" />
        {reachability === "auth" ? "API rejected" : "Unreachable"}
      </span>
    );
  }
  if (!lastSeenAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[color:var(--color-fg-muted)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-warn)]" />
        Not yet reached
      </span>
    );
  }
  // Reachable + a "last contact" label off `last_seen_at`. Under healthy polling
  // this is always seconds old ("· just now"); the red state above (not this
  // label) is what conveys an outage.
  const fresh = freshnessOf(lastSeenAt.toISOString());
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-success)]" />
      Reachable
      <span className="text-[color:var(--color-fg-muted)]">· {fresh.label}</span>
    </span>
  );
}

type SyncVerdict = "in-sync" | "lagging" | "unknown";

interface ServerRowProps {
  row: PdnsServer;
  indented: boolean;
  canReadAudit: boolean;
  lastEdits: Map<string, Date>;
  syncChip: SyncVerdict | null;
  reachability: "down" | "auth" | undefined;
}

function ServerRow({
  row,
  indented,
  canReadAudit,
  lastEdits,
  syncChip,
  reachability,
}: ServerRowProps) {
  return (
    <tr
      className={`border-t border-[color:var(--color-border)] ${serverRowAttentionClass(
        row.disabledAt,
        row.lastSeenAt,
        reachability,
      )}`}
    >
      <td className={`px-4 py-3 ${indented ? "pl-10" : ""}`}>
        <div className="flex items-center gap-2">
          {indented ? (
            <span aria-hidden className="font-mono text-[color:var(--color-fg-subtle)] select-none">
              └─
            </span>
          ) : null}
          <div className="font-medium">{row.name}</div>
          <span
            className={
              isReadOnlyMirror(row.capabilities)
                ? "rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-[0.6rem] font-medium text-[color:var(--color-fg-muted)]"
                : "rounded-full border border-[color:var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)] px-1.5 py-0.5 font-mono text-[0.6rem] font-medium text-[color:var(--color-accent)]"
            }
          >
            {summarizeCapabilities(row.capabilities)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-[color:var(--color-fg-muted)]">
          {row.slug}
          {row.isDefault ? (
            <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.65rem] tracking-wide uppercase">
              default
            </span>
          ) : null}
        </div>
        {row.description ? (
          <div className="mt-1 max-w-md truncate text-xs text-[color:var(--color-fg-muted)] italic">
            {row.description}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 font-mono text-xs">{row.baseUrl}</td>
      <td className="px-4 py-3">
        <HealthBadge
          disabledAt={row.disabledAt}
          lastSeenAt={row.lastSeenAt}
          reachability={reachability}
        />
      </td>
      <td className="px-4 py-3 text-xs">{row.versionCache?.version ?? "—"}</td>
      <td className="px-4 py-3 text-xs">
        <SyncChip verdict={syncChip} isMirror={isReadOnlyMirror(row.capabilities)} />
      </td>
      {canReadAudit ? (
        <td className="px-4 py-3 text-xs text-[color:var(--color-fg-muted)]">
          {lastEdits.has(row.id) ? (
            <span title={lastEdits.get(row.id)!.toISOString()}>
              {freshnessOf(lastEdits.get(row.id)!.toISOString()).label}
            </span>
          ) : (
            "—"
          )}
        </td>
      ) : null}
      <td className="px-4 py-3 text-right">
        <span className="inline-flex items-center gap-2">
          <TestServerButton serverId={row.id} />
          <Link
            href={`/admin/servers/${row.id}`}
            className="text-[color:var(--color-accent)] hover:underline"
          >
            Edit
          </Link>
        </span>
      </td>
    </tr>
  );
}

function SyncChip({ verdict, isMirror }: { verdict: SyncVerdict | null; isMirror: boolean }) {
  if (!isMirror) return <span className="text-[color:var(--color-fg-subtle)]">—</span>;
  if (verdict === null || verdict === "unknown") {
    return <span className="text-[color:var(--color-fg-muted)]">unknown</span>;
  }
  if (verdict === "in-sync") {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-success)]" />
        Synced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[color:var(--color-warn)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-warn)]" />
      Desynced
    </span>
  );
}

/**
 * Pure read against the in-process zone-state cache (populated by the
 * background poller). Compares each replicated zone's serial on the
 * secondary against the same zone on its primary.
 *
 * Only Master/Primary zones on the primary are expected to appear on
 * the secondary — Native (not replicated), Producer/Consumer (catalog
 * mechanism, not AXFR), and Slave/Secondary (which a primary
 * shouldn't have anyway) are skipped. Otherwise a Native zone would
 * always make the chip read "desynced" because it legitimately isn't
 * on the secondary at all.
 */
function computeSecondarySync(
  primaries: PdnsServer[],
  secondariesByPrimary: Map<string, PdnsServer[]>,
): Map<string, SyncVerdict> {
  const cache = rawCache();
  const out = new Map<string, SyncVerdict>();
  for (const primary of primaries) {
    const kids = secondariesByPrimary.get(primary.id) ?? [];
    const primaryEntry = cache.get(primary.id);
    for (const s of kids) {
      const secondaryEntry = cache.get(s.id);
      if (!primaryEntry || !secondaryEntry) {
        out.set(s.id, "unknown");
        continue;
      }
      let lagging = false;
      let anyMatch = false;
      for (const [zoneName, primarySnap] of primaryEntry.zones) {
        if (!isReplicatedKind(primarySnap.kind)) continue;
        const secondarySnap = secondaryEntry.zones.get(zoneName);
        if (!secondarySnap) {
          lagging = true;
          break;
        }
        if (primarySnap.serial === secondarySnap.serial) anyMatch = true;
        else {
          lagging = true;
          break;
        }
      }
      out.set(s.id, lagging ? "lagging" : anyMatch ? "in-sync" : "unknown");
    }
  }
  return out;
}

/**
 * Zones that PDNS replicates via AXFR. Everything else (Native,
 * Producer/Consumer catalogs, anything mistakenly tagged Slave on a
 * primary) is skipped by the sync check — those legitimately don't
 * mirror onto the secondary.
 */
function isReplicatedKind(kind: string): boolean {
  return kind === "Master" || kind === "Primary";
}
