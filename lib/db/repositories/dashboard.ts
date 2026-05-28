/**
 * lib/db/repositories/dashboard.ts
 *
 * Queries that power the dashboard's charts and KPI cards. Pure data access
 * — no permission checks, no formatting; the page composes and renders.
 *
 * Two sources:
 *   - `audit_log`: every state-changing action with a timestamp; great for
 *     activity series, top-N actors, action breakdown.
 *   - `metric_samples`: periodic snapshots (zone counts, latency, active
 *     sessions) maintained by the on-access sampler.
 */

import "server-only";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { metricSamples } from "@/lib/db/schema";
import { oidcProviders } from "@/lib/db/schema";
import { pdnsServers } from "@/lib/db/schema";
import { users } from "@/lib/db/schema";
import { countStar, isSqlite, jsonBoolField, truncToHour } from "@/lib/db/sql-dialect";
import { isWriteCapable } from "@/lib/pdns/capabilities";

// =============================================================================
// Audit-derived
// =============================================================================

export interface HourlyBucket {
  bucket: Date;
  count: number;
}

/**
 * Counts of audit events bucketed per hour for the last `hours` hours.
 * Optionally filter to a single action (e.g. "auth.login.success") or to
 * any matching by SQL `LIKE` pattern when `actionLike` is provided.
 */
export async function auditCountsPerHour(opts: {
  hours: number;
  action?: string;
  actionLike?: string;
}): Promise<HourlyBucket[]> {
  const since = new Date(Date.now() - opts.hours * 3600 * 1000);
  const conditions = [gte(auditLog.ts, since)];
  if (opts.action) conditions.push(eq(auditLog.action, opts.action));
  if (opts.actionLike) conditions.push(sql`${auditLog.action} LIKE ${opts.actionLike}`);

  const bucketExpr = truncToHour(auditLog.ts);
  const rows = await db
    .select({
      bucket: bucketExpr,
      count: countStar(),
    })
    .from(auditLog)
    .where(and(...conditions))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr);

  return rows.map((row) => ({
    // SQLite returns the truncated bucket as a UTC ISO string ('…THH:00:00Z',
    // see truncToHour); PG returns a Date. `new Date(str)` parses the 'Z' as
    // UTC so both dialects agree — without it the string would be read as
    // local time and skew the chart by the server's offset.
    bucket: row.bucket instanceof Date ? row.bucket : new Date(row.bucket as unknown as string),
    count: Number(row.count),
  }));
}

export interface TopActor {
  userId: string;
  email: string;
  name: string | null;
  count: number;
}

/** Most active users by audit-event count, last `days` days. */
export async function topActors(days: number, limit = 10): Promise<TopActor[]> {
  const since = new Date(Date.now() - days * 86400 * 1000);
  return db
    .select({
      userId: auditLog.actorId,
      email: users.email,
      name: users.name,
      count: countStar(),
    })
    .from(auditLog)
    .innerJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(gte(auditLog.ts, since), eq(auditLog.actorType, "user"), isNotNull(auditLog.actorId)),
    )
    .groupBy(auditLog.actorId, users.email, users.name)
    .orderBy(desc(sql`count(*)`))
    .limit(limit) as Promise<TopActor[]>;
}

export interface ActionBreakdownRow {
  action: string;
  count: number;
}

/** Action-frequency breakdown, last `days` days. */
export async function actionBreakdown(days: number, limit = 20): Promise<ActionBreakdownRow[]> {
  const since = new Date(Date.now() - days * 86400 * 1000);
  return db
    .select({
      action: auditLog.action,
      count: countStar(),
    })
    .from(auditLog)
    .where(gte(auditLog.ts, since))
    .groupBy(auditLog.action)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export interface RecentAuditRow {
  ts: Date;
  action: string;
  actorEmail: string | null;
  resourceType: string;
  resourceId: string | null;
}

export async function recentAudit(limit = 15): Promise<RecentAuditRow[]> {
  return db
    .select({
      ts: auditLog.ts,
      action: auditLog.action,
      actorEmail: users.email,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .orderBy(desc(auditLog.ts))
    .limit(limit);
}

// =============================================================================
// Sample-derived
// =============================================================================

export interface BackendStat {
  serverId: string;
  serverSlug: string;
  serverName: string;
  /** Whether this backend is a write target (ADR-0014, observed capability). */
  isWriteTarget: boolean;
  /** Cluster membership — when set, all peers in the cluster see the same
   *  zone set (backend-level replication), so the dashboard collapses them
   *  to one row when computing totals. Null for standalone primaries. */
  clusterId: string | null;
  zoneCount: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  sampledAt: Date | null;
}

/**
 * Latest sample per active backend, joined with backend identity. Returns
 * one row per active server even if no sample exists yet.
 */
export async function latestBackendSamples(): Promise<BackendStat[]> {
  const subquery = db
    .select({
      serverId: metricSamples.serverId,
      maxTs: sql<Date>`MAX(${metricSamples.sampledAt})`.as("max_ts"),
    })
    .from(metricSamples)
    .where(isNotNull(metricSamples.serverId))
    .groupBy(metricSamples.serverId)
    .as("latest");

  const rows = await db
    .select({
      serverId: pdnsServers.id,
      serverSlug: pdnsServers.slug,
      serverName: pdnsServers.name,
      capabilities: pdnsServers.capabilities,
      clusterId: pdnsServers.clusterId,
      zoneCount: metricSamples.zoneCount,
      latencyP50Ms: metricSamples.latencyP50Ms,
      latencyP95Ms: metricSamples.latencyP95Ms,
      sampledAt: metricSamples.sampledAt,
    })
    .from(pdnsServers)
    .leftJoin(subquery, eq(subquery.serverId, pdnsServers.id))
    .leftJoin(
      metricSamples,
      and(eq(metricSamples.serverId, pdnsServers.id), eq(metricSamples.sampledAt, subquery.maxTs)),
    )
    .where(isNull(pdnsServers.disabledAt))
    .orderBy(pdnsServers.name);

  return rows.map((row) => ({
    serverId: row.serverId,
    serverSlug: row.serverSlug,
    serverName: row.serverName,
    isWriteTarget: isWriteCapable(row.capabilities),
    clusterId: row.clusterId ?? null,
    zoneCount: row.zoneCount ?? null,
    latencyP50Ms: row.latencyP50Ms ?? null,
    latencyP95Ms: row.latencyP95Ms ?? null,
    sampledAt: row.sampledAt ?? null,
  }));
}

export interface BackendSeriesRow {
  serverId: string;
  serverSlug: string;
  serverName: string;
  sampledAt: Date;
  zoneCount: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/**
 * Per-backend time-series for the last `hours` hours. Used for the
 * "Zones per backend over time" and "PDNS p95 latency" charts.
 */
export async function backendSeries(hours: number): Promise<BackendSeriesRow[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  return db
    .select({
      serverId: metricSamples.serverId,
      serverSlug: pdnsServers.slug,
      serverName: pdnsServers.name,
      sampledAt: metricSamples.sampledAt,
      zoneCount: metricSamples.zoneCount,
      latencyP50Ms: metricSamples.latencyP50Ms,
      latencyP95Ms: metricSamples.latencyP95Ms,
    })
    .from(metricSamples)
    .innerJoin(pdnsServers, eq(metricSamples.serverId, pdnsServers.id))
    .where(and(gte(metricSamples.sampledAt, since), isNotNull(metricSamples.serverId)))
    .orderBy(metricSamples.sampledAt) as Promise<BackendSeriesRow[]>;
}

export interface SessionsSeriesRow {
  sampledAt: Date;
  activeSessions: number;
}

/**
 * Counts of users in attention-worthy states. Single round-trip
 * across the `users` table using FILTER predicates. Disabled
 * accounts are excluded from every bucket — they aren't actionable
 * (an admin already decided to turn them off).
 */
export interface UserAttentionCounts {
  /** Currently locked out (auto-clears at `locked_until`). */
  lockedOut: number;
  /** Local-password accounts with no `email_verified_at`. */
  unverifiedEmail: number;
  /** Active accounts with no TOTP secret. */
  noMfa: number;
  /** Active local accounts still flagged `must_change_password`. */
  mustChangePassword: number;
}

// PDNS-backend attention is computed on the dashboard from the live reachability
// store (`lib/realtime/backend-status`), not the DB — see app/(app)/dashboard.
// The old `last_seen_at`-derived counter lived here; it's gone so there's one
// reachability source.

/**
 * OIDC discovery health attention counts. Mirror of
 * `pdnsAttentionCounts` for the OIDC providers list, surfaced on the
 * dashboard once the T-103 sampler started keeping `discoveryCache`
 * fresh on every /admin/auth-providers/oidc page load:
 *   - `neverProbed`: enabled providers whose `discovery_cache` is
 *     null. Either freshly added (the next visit to the admin page
 *     will sample) or row predates the sampler.
 *   - `failing`: enabled providers whose latest probe set
 *     `discovery_cache.ok = false`. Most urgent actionable signal —
 *     the IdP is unreachable, misconfigured, or returning a bad
 *     discovery doc. Operator should click into the provider to
 *     read the reason hint.
 *
 * Disabled providers (enabled=false) are excluded — they're not
 * shown on the login page, so unreachability doesn't matter until
 * the operator re-enables them. Single round-trip via FILTER.
 *
 * Did NOT include a `stale` count like the PDNS variant: the T-103
 * sampler refreshes every 15 minutes on the admin-page load, so
 * "stale" in practice means "no one has visited /admin/oidc-
 * providers for 24h" — bucketed under operator inattention, not
 * provider health.
 */
export interface OidcAttentionCounts {
  neverProbed: number;
  failing: number;
}

export async function oidcAttentionCounts(): Promise<OidcAttentionCounts> {
  // `enabled` lives in JSON-as-text storage in SQLite (boolean mode wraps an
  // integer 0/1); the column itself is the dialect-decoded boolean and
  // compares against `true`/`1` identically.
  const enabledTrue = isSqlite
    ? sql`${oidcProviders.enabled} = 1`
    : sql`${oidcProviders.enabled} = true`;
  // The cached `ok` field is stored as a JSON boolean. Postgres' `->>` gives
  // the text "true"/"false"; SQLite's `json_extract` gives 1/0. Compare to
  // the appropriate per-dialect "false" literal.
  const okField = jsonBoolField(oidcProviders.discoveryCache, "ok");
  const failingPred = isSqlite ? sql`${okField} = 0` : sql`${okField} = false`;
  const rows = await db
    .select({
      neverProbed: sql<number>`count(*) filter (where ${enabledTrue} and ${oidcProviders.discoveryCache} is null)`,
      failing: sql<number>`count(*) filter (where ${enabledTrue} and ${oidcProviders.discoveryCache} is not null and ${failingPred})`,
    })
    .from(oidcProviders);
  const row = rows[0];
  return { neverProbed: Number(row?.neverProbed ?? 0), failing: Number(row?.failing ?? 0) };
}

export async function userAttentionCounts(): Promise<UserAttentionCounts> {
  const nowMs = Date.now();
  // For SQLite, `must_change_password` is stored as integer 0/1; for PG, boolean.
  const mustChangeTrue = isSqlite
    ? sql`${users.mustChangePassword} = 1`
    : sql`${users.mustChangePassword} = true`;
  // For SQLite, timestamps are integer ms — compare against a literal number;
  // for PG, lockedUntil is timestamptz — compare against the `now()` literal.
  const stillLocked = isSqlite
    ? sql`${users.lockedUntil} > ${nowMs}`
    : sql`${users.lockedUntil} > now()`;
  const rows = await db
    .select({
      lockedOut: sql<number>`count(*) filter (where ${stillLocked})`,
      unverifiedEmail: sql<number>`count(*) filter (where ${users.emailVerifiedAt} is null and ${users.disabledAt} is null and ${users.passwordHash} is not null)`,
      // SSO-only users (no local password hash) sign in via the IdP,
      // which is their second-factor authority. They don't need (and
      // can't enable) local TOTP on this side. Excluding them keeps
      // the "no MFA" chip from lighting up for every SSO-only account.
      noMfa: sql<number>`count(*) filter (where ${users.totpSecretEncrypted} is null and ${users.disabledAt} is null and ${users.passwordHash} is not null)`,
      mustChangePassword: sql<number>`count(*) filter (where ${mustChangeTrue} and ${users.disabledAt} is null)`,
    })
    .from(users);
  const row = rows[0];
  return {
    lockedOut: Number(row?.lockedOut ?? 0),
    unverifiedEmail: Number(row?.unverifiedEmail ?? 0),
    noMfa: Number(row?.noMfa ?? 0),
    mustChangePassword: Number(row?.mustChangePassword ?? 0),
  };
}

export async function sessionsSeries(hours: number): Promise<SessionsSeriesRow[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = await db
    .select({
      sampledAt: metricSamples.sampledAt,
      activeSessions: metricSamples.activeSessions,
    })
    .from(metricSamples)
    .where(and(gte(metricSamples.sampledAt, since), isNotNull(metricSamples.activeSessions)))
    .orderBy(metricSamples.sampledAt);
  return rows.map((row) => ({
    sampledAt: row.sampledAt,
    activeSessions: row.activeSessions ?? 0,
  }));
}
