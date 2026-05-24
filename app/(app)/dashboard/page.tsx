/**
 * app/(app)/dashboard/page.tsx
 *
 * Operator dashboard: a row of KPI cards followed by ECharts visualizations
 * built from the audit log + the background metric samples.
 *
 * Data flow:
 *   1. `ensurePollerRunning()` kicks the unified background poller (zone-state
 *      + PDNS `/statistics` + the 5-min `metric_samples` snapshot) if it isn't
 *      already running. The page itself does no sampling — it renders against
 *      whatever the poller has already written.
 *   2. All chart data is fetched via the dashboard repo; ECharts option
 *      objects are composed server-side and shipped as props to the
 *      `<Chart>` client component (no client-side data fetching needed).
 *
 * The page stays a server component; only the chart wrapper opts into the
 * client runtime (ECharts is canvas-based, can't render on the server).
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import {
  actionBreakdown,
  auditCountsPerHour,
  backendSeries,
  latestBackendSamples,
  oidcAttentionCounts,
  recentAudit,
  sessionsSeries,
  topActors,
  userAttentionCounts,
} from "@/lib/db/repositories/dashboard";
import {
  listSecondariesForPrimary,
  listAllPdnsServers,
  listAllPrimaries,
} from "@/lib/db/repositories/pdns-servers";
import { readRecentMetrics } from "@/lib/metrics/pdns-stats-sampler";
import { ensurePollerRunning, ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { getBackendStatus } from "@/lib/realtime/backend-status";
import { CounterRateChart, MapPieChart, ValueLineChart } from "@/components/domain/pdns-stat-chart";
import { Chart } from "@/components/ui/chart";
import { LocalTime } from "@/components/ui/local-time";
import { UnverifiedEmailBanner } from "./_components/unverified-email-banner";
import { DashboardLiveFeed } from "./_components/dashboard-live-feed";
import {
  actionPieOption,
  bucketResponseSizes,
  hourlyLineOption,
  multiSeriesOption,
  sessionsOption,
  topActorsOption,
} from "./_components/chart-options";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const HOURS_24 = 24;
const HOURS_7D = 24 * 7;

interface DashboardProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function DashboardPage({ searchParams }: DashboardProps) {
  const { user, ability } = await requireUserForPage();
  const { tab: requestedTab } = await searchParams;
  // Two tabs: pdns (PowerDNS server statistics — default) vs. admin
  // (audit/user/server admin metrics, reached via ?tab=admin).
  const tab: "admin" | "pdns" = requestedTab === "admin" ? "admin" : "pdns";

  // Permission gates. Every section below is scoped to the perms the actor
  // has — a freshly-provisioned OIDC user with no roles sees just the
  // welcome message and the password-rotation banner (if applicable). Audit
  // and server stats are sensitive (actor names, internal hostnames,
  // request volumes) and only render for users explicitly granted access.
  const canReadAudit = ability.can("read", "Audit");
  const canReadServers = ability.can("read", "Server");
  const canReadZones = ability.can("read", "Zone");
  const canCreateServer = ability.can("create", "Server");
  const canReadUsers = ability.can("read", "User");
  const canReadOidc = ability.can("read", "Oidc");

  // Ask the broker to ensure a recent observation so the PDNS-attention tiles
  // read live reachability (same source as the servers list + bell). For an
  // audit-only viewer, just keep the poller alive for the realtime feed.
  if (canReadServers) {
    await ensureBackendsObserved();
  } else if (canReadAudit) {
    ensurePollerRunning();
  }

  // Conditionally fetch only the data the user is allowed to see. Each
  // permission gate maps to a clearly-defined slice of the dashboard.
  const [
    editsHourly,
    loginsHourly,
    actorBars,
    actionPie,
    backendsLatest,
    backendTimeSeries,
    sessionsTimeSeries,
    recent,
    servers,
    attention,
    oidcAttention,
  ] = await Promise.all([
    canReadAudit
      ? auditCountsPerHour({ hours: HOURS_24, actionLike: "record.%" })
      : Promise.resolve([]),
    canReadAudit
      ? auditCountsPerHour({ hours: HOURS_24, action: "auth.login.success" })
      : Promise.resolve([]),
    canReadAudit ? topActors(7, 8) : Promise.resolve([]),
    canReadAudit ? actionBreakdown(7, 8) : Promise.resolve([]),
    canReadServers ? latestBackendSamples() : Promise.resolve([]),
    canReadServers ? backendSeries(HOURS_7D) : Promise.resolve([]),
    canReadAudit ? sessionsSeries(HOURS_7D) : Promise.resolve([]),
    canReadAudit ? recentAudit(12) : Promise.resolve([]),
    canReadServers ? listAllPdnsServers() : Promise.resolve([]),
    canReadUsers
      ? userAttentionCounts()
      : Promise.resolve({ lockedOut: 0, unverifiedEmail: 0, noMfa: 0, mustChangePassword: 0 }),
    canReadOidc ? oidcAttentionCounts() : Promise.resolve({ neverProbed: 0, failing: 0 }),
  ]);

  // PDNS attention from the live reachability store (the single source of truth):
  // an active backend the broker can't reach now, or one never observed yet.
  // Same signal the servers list + bell read, so the dashboard agrees with them.
  const pdnsAttention = { neverProbed: 0, unreachable: 0 };
  if (canReadServers) {
    for (const s of servers) {
      if (s.disabledAt !== null) continue;
      const status = getBackendStatus(s.id);
      if (!status) pdnsAttention.neverProbed += 1;
      else if (!status.reachable) pdnsAttention.unreachable += 1;
    }
  }

  // Primaries only — secondaries mirror their primary's zone set, so
  // including them here would double-count.
  const primaryBackends = backendsLatest.filter((b) => b.isWriteTarget);
  // De-duplicate cluster peers: every peer in a cluster shares the same
  // backend storage, so they report the same zone set. Counting all 3
  // peers would triple-count. Pick one peer per cluster (whichever has the
  // non-null zoneCount; otherwise the first one) for the total.
  const seenClusters = new Set<string>();
  const totalZones = primaryBackends.reduce((sum, b) => {
    if (b.clusterId !== null) {
      if (seenClusters.has(b.clusterId)) return sum;
      seenClusters.add(b.clusterId);
    }
    return sum + (b.zoneCount ?? 0);
  }, 0);
  const currentSessions = sessionsTimeSeries[sessionsTimeSeries.length - 1]?.activeSessions ?? 0;
  const editCountLast24h = editsHourly.reduce((sum, b) => sum + b.count, 0);
  const hasAnyPanel = canReadAudit || canReadServers || canReadZones;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              Welcome, {user.name ?? user.email.split("@")[0]}
            </h1>
            {canReadAudit ? <DashboardLiveFeed /> : null}
          </div>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Operational snapshot of every backend, every actor, every action.
          </p>
        </div>
      </header>

      {/* Email-verification banner — LOCAL (password) accounts only.
          OIDC/SSO users (no passwordHash) are exempt: their identity and
          email are owned by the IdP and the app runs no verification flow
          for them. This mirrors the SSO-only MFA exemption in (app)/layout. */}
      {user.emailVerifiedAt === null && user.passwordHash !== null ? (
        <UnverifiedEmailBanner />
      ) : null}

      {/* Forced password change — surfaced right below the header, above the
          KPIs, so it's the first thing the operator acts on. */}
      {user.mustChangePassword ? (
        <section className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm">
          <strong>Change your password.</strong> Your account was set up with a temporary password.
          Update it from your{" "}
          <Link href="/profile" className="underline">
            profile
          </Link>
          .
        </section>
      ) : null}

      {/* KPI cards — each one is conditional on the perm needed to derive it. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {canReadAudit ? (
          <KpiCard label="Active sessions" value={String(currentSessions)} href="/profile" />
        ) : null}
        {canReadZones && canReadServers ? (
          <KpiCard
            label="Zones (total)"
            value={String(totalZones)}
            sub={`across ${primaryBackends.length} primary backend${primaryBackends.length === 1 ? "" : "s"}`}
            href="/zones"
          />
        ) : null}
        {canReadServers ? (
          <KpiCard
            label="PowerDNS backends"
            value={String(servers.length)}
            sub={`${servers.filter((s) => s.disabledAt === null).length} active`}
            href="/admin/servers"
          />
        ) : null}
        {canReadAudit ? (
          <KpiCard
            label="Record changes (24h)"
            value={String(editCountLast24h)}
            href="/admin/audit"
          />
        ) : null}
      </div>

      {/* Attention required — admin-only at-a-glance counts of users
          in actionable states. Hidden entirely when all counters are
          zero, so a healthy deployment doesn't show a "0 items"
          shelf. Each tile links to a pre-filtered users list when
          there's something to look at. */}
      {canReadUsers && hasAttention(attention) ? <AttentionWidget counts={attention} /> : null}

      {canReadServers && hasPdnsAttention(pdnsAttention) ? (
        <PdnsAttentionWidget counts={pdnsAttention} />
      ) : null}

      {canReadOidc && hasOidcAttention(oidcAttention) ? (
        <OidcAttentionWidget counts={oidcAttention} />
      ) : null}

      <DashboardTabStrip active={tab} />

      {tab === "pdns" ? (
        canReadServers ? (
          <Suspense fallback={<PdnsStatsSectionFallback />}>
            <PdnsStatsSection />
          </Suspense>
        ) : (
          <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
            You don&apos;t have permission to view PowerDNS server statistics.
          </p>
        )
      ) : (
        <>
          {/* Activity charts — audit-derived. */}
          {canReadAudit ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard
                title="Record changes — last 24h"
                subtitle="Per-hour bucket of record.create/update/delete events"
              >
                <Chart option={hourlyLineOption(editsHourly, HOURS_24, "Edits")} height={260} />
              </ChartCard>
              <ChartCard
                title="Successful logins — last 24h"
                subtitle="Per-hour bucket of auth.login.success events"
              >
                <Chart option={hourlyLineOption(loginsHourly, HOURS_24, "Logins")} height={260} />
              </ChartCard>
            </div>
          ) : null}

          {/* Backend health — exposes hostnames + latency, gated by server.read. */}
          {canReadServers ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard
                title="Zones per backend — last 7 days"
                subtitle="One sample per ~5 minutes; gaps mean the backend wasn't sampled"
              >
                <Chart
                  option={multiSeriesOption(backendTimeSeries, "zoneCount", "Zones")}
                  height={260}
                />
              </ChartCard>
              <ChartCard
                title="PowerDNS p95 latency — last 7 days"
                subtitle="Milliseconds (lower is better)"
              >
                <Chart
                  option={multiSeriesOption(backendTimeSeries, "latencyP95Ms", "ms")}
                  height={260}
                />
              </ChartCard>
            </div>
          ) : null}

          {/* Top actors leaks user names; action breakdown leaks app activity. */}
          {canReadAudit ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard
                title="Top actors — last 7 days"
                subtitle="Users by number of audited actions"
              >
                <Chart option={topActorsOption(actorBars)} height={260} />
              </ChartCard>
              <ChartCard
                title="Action breakdown — last 7 days"
                subtitle="Top 8 actions by frequency"
              >
                <Chart option={actionPieOption(actionPie)} height={260} />
              </ChartCard>
            </div>
          ) : null}

          {/* Sessions chart + backends snapshot table */}
          {canReadAudit || canReadServers ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {canReadAudit ? (
                <ChartCard
                  title="Active sessions — last 7 days"
                  subtitle="Snapshot per dashboard load (~5 min cadence)"
                >
                  <Chart option={sessionsOption(sessionsTimeSeries)} height={260} />
                </ChartCard>
              ) : null}
              {canReadServers ? (
                <Card title="Backends snapshot">
                  <div className="overflow-hidden rounded-md border border-[color:var(--color-border)] text-sm">
                    <table className="w-full">
                      <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                        <tr>
                          <th className="px-3 py-1.5">Backend</th>
                          <th className="px-3 py-1.5">Zones</th>
                          <th className="px-3 py-1.5">p50</th>
                          <th className="px-3 py-1.5">p95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backendsLatest.length === 0 ? (
                          <tr>
                            <td
                              colSpan={4}
                              className="px-3 py-6 text-center text-xs text-[color:var(--color-fg-muted)]"
                            >
                              No active backends.
                              {canCreateServer ? (
                                <>
                                  {" "}
                                  <Link
                                    href="/admin/servers/new"
                                    className="text-[color:var(--color-accent)] hover:underline"
                                  >
                                    Add one
                                  </Link>
                                  .
                                </>
                              ) : null}
                            </td>
                          </tr>
                        ) : (
                          backendsLatest.map((b) => (
                            <tr
                              key={b.serverId}
                              className="border-t border-[color:var(--color-border)]"
                            >
                              <td className="px-3 py-2 font-medium">
                                <Link
                                  href={`/admin/servers/${b.serverId}`}
                                  className="text-[color:var(--color-accent)] hover:underline"
                                >
                                  {b.serverName}
                                </Link>
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">{b.zoneCount ?? "—"}</td>
                              <td className="px-3 py-2 font-mono text-xs">
                                {b.latencyP50Ms === null ? "—" : `${Math.round(b.latencyP50Ms)}ms`}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">
                                {b.latencyP95Ms === null ? "—" : `${Math.round(b.latencyP95Ms)}ms`}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}
            </div>
          ) : null}

          {/* Recent activity preview — audit content, gated by audit.read. */}
          {canReadAudit ? (
            <Card
              title="Recent activity"
              action={
                <Link
                  href="/admin/audit"
                  className="text-xs text-[color:var(--color-accent)] hover:underline"
                >
                  View all →
                </Link>
              }
            >
              {recent.length === 0 ? (
                <p className="text-sm text-[color:var(--color-fg-muted)]">No audit entries yet.</p>
              ) : (
                <div className="overflow-hidden rounded-md border border-[color:var(--color-border)] text-sm">
                  <table className="w-full">
                    <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                      <tr>
                        <th className="px-3 py-1.5">When</th>
                        <th className="px-3 py-1.5">Actor</th>
                        <th className="px-3 py-1.5">Action</th>
                        <th className="px-3 py-1.5">Resource</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((row, idx) => (
                        <tr key={idx} className="border-t border-[color:var(--color-border)]">
                          <td className="px-3 py-2 font-mono text-xs">
                            <LocalTime ts={row.ts} />
                          </td>
                          <td className="px-3 py-2 text-xs">{row.actorEmail ?? "system"}</td>
                          <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                          <td className="px-3 py-2 text-xs">
                            <span className="text-[color:var(--color-fg-muted)]">
                              {row.resourceType}
                            </span>
                            {row.resourceId ? (
                              <span className="ml-2 font-mono text-[0.7rem]">
                                {row.resourceId.slice(0, 32)}
                                {row.resourceId.length > 32 ? "…" : ""}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : null}
        </>
      )}

      {!hasAnyPanel ? (
        <section className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          You&apos;re signed in but no panels are visible to your role yet. An administrator can
          grant additional permissions if you should see zones, audit history, or server health
          here.
        </section>
      ) : null}
    </div>
  );
}

// =============================================================================
// Layout primitives
// =============================================================================

function KpiCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <>
      <div className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{sub}</div> : null}
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4 transition-colors hover:bg-[color:var(--color-bg-muted)]"
    >
      {inner}
    </Link>
  ) : (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
      {inner}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
      <header className="mb-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle ? <p className="text-xs text-[color:var(--color-fg-muted)]">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * Inline attention-widget. Lives at the top of the dashboard for
 * admins (gated by `user.read`). Surfaces operational items that
 * need human action — locked-out users (incident triage), users
 * without MFA (policy hardening), unverified emails (signup
 * follow-up), forced password changes pending.
 *
 * Hidden when every count is zero — a clean deployment shouldn't
 * see an empty alert shelf.
 */
function hasAttention(c: {
  lockedOut: number;
  unverifiedEmail: number;
  noMfa: number;
  mustChangePassword: number;
}): boolean {
  return c.lockedOut + c.unverifiedEmail + c.noMfa + c.mustChangePassword > 0;
}

function AttentionWidget({
  counts,
}: {
  counts: {
    lockedOut: number;
    unverifiedEmail: number;
    noMfa: number;
    mustChangePassword: number;
  };
}) {
  return (
    <section
      className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/5 p-4"
      aria-label="Items needing attention"
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Attention required
        </h2>
        <span className="text-xs text-[color:var(--color-fg-muted)]">
          Users in a state worth a second look. Click a tile to jump to the list.
        </span>
      </header>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <AttentionTile
          label="Locked out"
          count={counts.lockedOut}
          tone="error"
          href="/admin/users?filter=locked"
        />
        <AttentionTile
          label="No MFA"
          count={counts.noMfa}
          tone="warn"
          href="/admin/users?filter=no-mfa"
        />
        <AttentionTile
          label="Unverified email"
          count={counts.unverifiedEmail}
          tone="warn"
          href="/admin/users?filter=unverified"
        />
        <AttentionTile
          label="Must change password"
          count={counts.mustChangePassword}
          tone="info"
          href="/admin/users?filter=must-change"
        />
      </div>
    </section>
  );
}

function AttentionTile({
  label,
  count,
  tone,
  href,
}: {
  label: string;
  count: number;
  tone: "error" | "warn" | "info";
  href: string;
}) {
  // Zero-count tiles render muted + non-link so they don't suggest
  // an action. The widget hides entirely when ALL counts are zero
  // (`hasAttention` guard), so showing some zero tiles only happens
  // when at least one other tile is non-zero.
  if (count === 0) {
    return (
      <div className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 opacity-60">
        <div className="text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          {label}
        </div>
        <div className="mt-1 text-xl font-semibold tabular-nums">0</div>
      </div>
    );
  }
  const dotColor =
    tone === "error"
      ? "bg-[color:var(--color-error)]"
      : tone === "warn"
        ? "bg-[color:var(--color-warn)]"
        : "bg-[color:var(--color-accent)]";
  return (
    <Link
      href={href}
      className="block rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 transition-colors hover:bg-[color:var(--color-bg-muted)]"
    >
      <div className="flex items-center gap-2 text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{count}</div>
    </Link>
  );
}

/**
 * PDNS backend attention widget. Mirror of the user
 * attention widget for backend ops. Hidden when both counters are
 * zero (healthy fleet doesn't see an empty alert shelf).
 *
 * Tile semantics:
 *   - "Never observed": a freshly-added backend the broker hasn't reached
 *      yet — actionable via the Test button on the row.
 *   - "Unreachable": the broker can't reach it right now (live status) — the
 *      same signal the servers list + bell show; operator should Test/fix.
 */
function hasPdnsAttention(c: { neverProbed: number; unreachable: number }): boolean {
  return c.neverProbed + c.unreachable > 0;
}

function PdnsAttentionWidget({ counts }: { counts: { neverProbed: number; unreachable: number } }) {
  return (
    <section
      className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/5 p-4"
      aria-label="PDNS backends needing attention"
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          PDNS backends needing attention
        </h2>
        <span className="text-xs text-[color:var(--color-fg-muted)]">
          Live reachability across configured backends. Click a tile to jump to the list and Test.
        </span>
      </header>
      <div className="grid gap-2 sm:grid-cols-2">
        <AttentionTile
          label="Never observed"
          count={counts.neverProbed}
          tone="warn"
          href="/admin/servers"
        />
        <AttentionTile
          label="Unreachable"
          count={counts.unreachable}
          tone="error"
          href="/admin/servers"
        />
      </div>
    </section>
  );
}

/**
 * OIDC discovery attention widget. Mirror of the PDNS
 * variant. Surfaces enabled providers whose discovery probe is
 * either missing entirely (`Never probed`) or actively failing
 * (`Failing probe` — discovery_cache.ok=false). Hidden when both
 * counts are zero so healthy fleets see nothing. Tiles deep-link
 * to /admin/oidc-providers where each row's discovery badge
 * carries the human-readable reason.
 */
function hasOidcAttention(c: { neverProbed: number; failing: number }): boolean {
  return c.neverProbed + c.failing > 0;
}

function OidcAttentionWidget({ counts }: { counts: { neverProbed: number; failing: number } }) {
  return (
    <section
      className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/5 p-4"
      aria-label="OIDC providers needing attention"
    >
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          OIDC providers needing attention
        </h2>
        <span className="text-xs text-[color:var(--color-fg-muted)]">
          Discovery probe state across enabled providers. Click a tile to inspect the failure
          reason.
        </span>
      </header>
      <div className="grid gap-2 sm:grid-cols-2">
        <AttentionTile
          label="Never probed"
          count={counts.neverProbed}
          tone="warn"
          href="/admin/oidc-providers"
        />
        <AttentionTile
          label="Failing probe"
          count={counts.failing}
          tone="error"
          href="/admin/oidc-providers"
        />
      </div>
    </section>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * Per-backend card with live PDNS statistics — query rate, latency,
 * cache hit ratio, response-by-qtype, response-by-rcode. Pulls from
 * the `pdns_server_stats` table (populated by the sampler at top of
 * the page render). Renders one full-width card per primary plus
 * one card per secondary, grouped under the primary they back.
 */
async function PdnsStatsSection() {
  const primaries = await listAllPrimaries();
  const active = primaries.filter((p) => p.disabledAt === null);
  if (active.length === 0) {
    return (
      <section className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
        No active PowerDNS primaries configured.{" "}
        <Link
          href="/admin/servers/new"
          className="text-[color:var(--color-accent)] hover:underline"
        >
          Add one
        </Link>
        .
      </section>
    );
  }

  const secondariesByPrimary = await Promise.all(
    active.map(async (p) => ({
      primary: p,
      secondaries: await listSecondariesForPrimary(p),
    })),
  );

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">PowerDNS statistics</h2>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Live counters polled from every primary and secondary every ~60s. Each card plots query
          rate, latency, cache hit ratio, and response composition.
        </p>
      </header>
      <div className="space-y-4">
        {secondariesByPrimary.map(({ primary, secondaries }) => (
          <div key={primary.id} className="space-y-3">
            <PdnsStatsCard serverId={primary.id} serverName={primary.name} role="primary" />
            {secondaries.map((s) => (
              <PdnsStatsCard key={s.id} serverId={s.id} serverName={s.name} role="secondary" />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function PdnsStatsSectionFallback() {
  return (
    <section className="animate-pulse space-y-3">
      <header>
        <div className="h-6 w-56 rounded bg-[color:var(--color-bg-subtle)]" />
        <div className="mt-2 h-4 w-96 rounded bg-[color:var(--color-bg-subtle)]" />
      </header>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-md border border-[color:var(--color-border)] p-4">
          <div className="h-5 w-48 rounded bg-[color:var(--color-bg-subtle)]" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, j) => (
              <div
                key={j}
                className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3"
              >
                <div className="h-3 w-32 rounded bg-[color:var(--color-bg-muted)]" />
                <div className="mt-3 h-40 rounded bg-[color:var(--color-bg-muted)]" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

async function PdnsStatsCard({
  serverId,
  serverName,
  role,
}: {
  serverId: string;
  serverName: string;
  role: "primary" | "secondary";
}) {
  const metrics = await readRecentMetrics(
    serverId,
    [
      "udp4-queries",
      "udp6-queries",
      "tcp4-queries",
      "tcp6-queries",
      "latency",
      "packetcache-hit",
      "packetcache-miss",
      "response-by-qtype",
      "response-by-rcode",
      "response-sizes",
    ],
    120,
  );

  // Sum the four query-source counters point-wise.
  const queryNames = ["udp4-queries", "udp6-queries", "tcp4-queries", "tcp6-queries"];
  const queryByTs = new Map<string, number>();
  for (const n of queryNames) {
    for (const s of metrics.get(n) ?? []) {
      if (s.value === null) continue;
      const key = new Date(s.ts).toISOString();
      queryByTs.set(key, (queryByTs.get(key) ?? 0) + s.value);
    }
  }
  const querySamples = Array.from(queryByTs.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ts, value]) => ({ ts, value }));

  const latencySamples = (metrics.get("latency") ?? [])
    .filter((s): s is { ts: Date; value: number; mapValue: unknown } => s.value !== null)
    .map((s) => ({ ts: s.ts.toISOString(), value: s.value }));

  const hitRaw = metrics.get("packetcache-hit") ?? [];
  const missRaw = metrics.get("packetcache-miss") ?? [];
  const byTsHit = new Map(hitRaw.map((s) => [s.ts.toISOString(), s.value]));
  const byTsMiss = new Map(missRaw.map((s) => [s.ts.toISOString(), s.value]));
  const ratioSamples: Array<{ ts: string; value: number }> = [];
  for (const [ts, h] of byTsHit) {
    const m = byTsMiss.get(ts);
    if (h === null || m === null || m === undefined) continue;
    const total = h + m;
    if (total === 0) continue;
    ratioSamples.push({ ts, value: (h / total) * 100 });
  }
  ratioSamples.sort((a, b) => a.ts.localeCompare(b.ts));

  const qtypeSeries = metrics.get("response-by-qtype") ?? [];
  const latestQtype = qtypeSeries[qtypeSeries.length - 1]?.mapValue;
  const rcodeSeries = metrics.get("response-by-rcode") ?? [];
  const latestRcode = rcodeSeries[rcodeSeries.length - 1]?.mapValue;
  const sizesSeries = metrics.get("response-sizes") ?? [];
  const latestSizes = sizesSeries[sizesSeries.length - 1]?.mapValue;
  const sizeBuckets = Array.isArray(latestSizes)
    ? bucketResponseSizes(latestSizes as Array<{ name: string; value: string }>)
    : [];

  return (
    <div className="space-y-3 rounded-md border border-[color:var(--color-border)] p-4">
      <header className="flex items-center gap-2">
        <h3 className="font-medium">{serverName}</h3>
        <span
          className={
            role === "primary"
              ? "inline-flex items-center rounded-full border border-[color:var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-accent)] uppercase"
              : "inline-flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase"
          }
        >
          {role}
        </span>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatBlock title="Query rate (q/s)">
          {querySamples.length > 1 ? (
            <CounterRateChart
              samples={querySamples}
              label="queries"
              height={160}
              yAxisLabel="q/s"
            />
          ) : (
            <StatEmpty label="Not enough samples yet — collecting." />
          )}
        </StatBlock>
        <StatBlock title="Latency (µs)">
          {latencySamples.length > 1 ? (
            <ValueLineChart samples={latencySamples} label="latency" height={160} yAxisLabel="µs" />
          ) : (
            <StatEmpty label="Not enough samples yet." />
          )}
        </StatBlock>
        <StatBlock title="Packet cache hit ratio (%)">
          {ratioSamples.length > 1 ? (
            <ValueLineChart samples={ratioSamples} label="hit %" height={160} yAxisLabel="%" />
          ) : (
            <StatEmpty label="Not enough samples yet." />
          )}
        </StatBlock>
        <StatBlock title="Response by qtype">
          {Array.isArray(latestQtype) && latestQtype.length > 0 ? (
            <MapPieChart
              entries={latestQtype as Array<{ name: string; value: string }>}
              height={180}
            />
          ) : (
            <StatEmpty label="No qtype data yet." />
          )}
        </StatBlock>
        <StatBlock title="Response by rcode">
          {Array.isArray(latestRcode) && latestRcode.length > 0 ? (
            <MapPieChart
              entries={latestRcode as Array<{ name: string; value: string }>}
              height={180}
            />
          ) : (
            <StatEmpty label="No rcode data yet." />
          )}
        </StatBlock>
        <StatBlock title="Response sizes (bytes)">
          {sizeBuckets.length > 0 ? (
            <MapPieChart entries={sizeBuckets} height={180} preserveOrder />
          ) : (
            <StatEmpty label="No response-size data yet." />
          )}
        </StatBlock>
      </div>
    </div>
  );
}

function StatBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3">
      <h4 className="mb-1 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {title}
      </h4>
      {children}
    </div>
  );
}

function StatEmpty({ label }: { label: string }) {
  return <p className="py-8 text-center text-xs text-[color:var(--color-fg-muted)]">{label}</p>;
}

function DashboardTabStrip({ active }: { active: "admin" | "pdns" }) {
  return (
    <div className="border-b border-[color:var(--color-border)]">
      <nav className="-mb-px flex gap-6 text-sm">
        <DashboardTab href="/dashboard" active={active === "pdns"}>
          PowerDNS stats
        </DashboardTab>
        <DashboardTab href="/dashboard?tab=admin" active={active === "admin"}>
          PDNS Auth Admin
        </DashboardTab>
      </nav>
    </div>
  );
}

function DashboardTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "border-b-2 border-[color:var(--color-accent)] px-1 pb-3 font-medium text-[color:var(--color-fg)]"
          : "border-b-2 border-transparent px-1 pb-3 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
      }
    >
      {children}
    </Link>
  );
}
