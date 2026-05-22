/**
 * lib/db/repositories/audit-log.ts
 *
 * Scoped queries against `audit_log` — currently used by the per-zone change
 * log on the zone detail page. The dashboard repo has its own broader
 * audit aggregations; this file is for narrower, resource-scoped reads.
 *
 * Resource-id convention (defined by the PATCH route writers):
 *   - rrset:   `${serverSlug}:${zoneName}:${rrsetName}|${rrsetType}`
 *   - zone:    `${serverSlug}:${zoneName}`
 *
 * Both prefixes start with `${serverSlug}:${zoneName}`, so a single LIKE
 * matches both. The query joins users to resolve actor emails inline.
 */

import "server-only";
import { and, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { users } from "@/lib/db/schema";
import { castToText, castToNullableText, countStar } from "@/lib/db/sql-dialect";
import { escapeLikePattern } from "./audit-like";

/**
 * Build the resource-id scope for a single zone's audit rows.
 *
 * The two writers use:
 *   - zone:   `${serverSlug}:${zoneName}`               (exact)
 *   - rrset:  `${serverSlug}:${zoneName}:${name}|${type}` (prefix + ":")
 *
 * A naive `LIKE '${prefix}%'` over-matches: DNS zone names legally contain `_`
 * (a LIKE single-char wildcard), so `slug:a_b` would also match `slug:axb`, and
 * the bare prefix would match a sibling zone whose name starts with this one's
 * (`example.com` vs `example.com.au`). We instead match the exact zone row OR
 * the rrset rows under it (`prefix:%`), with the prefix LIKE-escaped and an
 * explicit `ESCAPE '\'` so the escaping is honored on SQLite (no default escape
 * char) and a no-op on Postgres (backslash is already its default).
 */
function zoneResourceScope(serverSlug: string, zoneName: string): SQL {
  const prefix = `${serverSlug}:${zoneName}`;
  const childPattern = `${escapeLikePattern(prefix)}:%`;
  return or(
    eq(auditLog.resourceId, prefix),
    sql`${auditLog.resourceId} LIKE ${childPattern} ESCAPE '\\'`,
  )!;
}

/**
 * Drizzle's `node-postgres` driver overrides pg's default TIMESTAMPTZ
 * parser with identity (see node_modules/drizzle-orm/node-postgres/session.cjs),
 * relying on column metadata in `mapResultRow` to convert strings → Date.
 * Raw `sql<Date>`max(${col})`` expressions have no column metadata, so the
 * driver passes the wire-format string through unchanged. Coerce here.
 */
function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface ZoneAuditEntry {
  id: string;
  ts: Date;
  actorType: "user" | "token" | "system";
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  /**
   * Operation grouping key — every audit row written within the same
   * HTTP request shares this. The change-history feed links each entry
   * to `/admin/audit?requestId=<id>` so an operator can see every side
   * effect of one operation (e.g. `record.update` + the subsequent
   * `zone.notify`) on the audit-log page.
   */
  requestId: string | null;
}

/**
 * Recent audit rows scoped to a single zone on a single PDNS backend. Most
 * recent first.
 *
 * Joined on users so the UI can show "Jane Doe (jane@…) edited this RRset"
 * without a second round-trip. Token / system actors come through with
 * null email + name.
 */
export async function zoneAuditLog(
  serverSlug: string,
  zoneName: string,
  limit = 100,
): Promise<ZoneAuditEntry[]> {
  const rows = await db
    .select({
      id: castToText(auditLog.id),
      ts: auditLog.ts,
      actorType: auditLog.actorType,
      actorEmail: users.email,
      actorName: users.name,
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      before: auditLog.before,
      after: auditLog.after,
      ip: castToNullableText(auditLog.ip),
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        or(eq(auditLog.resourceType, "rrset"), eq(auditLog.resourceType, "zone")),
        zoneResourceScope(serverSlug, zoneName),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(limit);

  return rows;
}

/**
 * Latest non-`zone.notify` audit row for a single zone on a single
 * backend. Used by the zone-detail header to surface a "last edit"
 * stat — operators landing on the page want to see "modified 2h ago
 * by alice@…" at a glance instead of clicking through to History.
 *
 * Returns null when the zone has no recorded edits (newly imported
 * or pre-audit-log existence). Same join + scope rules as
 * `zoneAuditLog` so the freshness label is consistent across both
 * surfaces.
 */
/**
 * Per-zone activity counts over the last 7 days, grouped by action type.
 * Used by the zone detail Statistics tab to show "records added / NOTIFY
 * sent / DNSSEC ops" without a separate query per category.
 */
export async function zoneAuditCounts7d(
  serverSlug: string,
  zoneName: string,
): Promise<{
  recordCreate: number;
  recordUpdate: number;
  recordDelete: number;
  notify: number;
  metadata: number;
  settings: number;
  dnssec: number;
  total: number;
}> {
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = await db
    .select({ action: auditLog.action, n: countStar() })
    .from(auditLog)
    .where(
      and(
        sql`${auditLog.ts} >= ${new Date(sinceMs)}`,
        or(eq(auditLog.resourceType, "rrset"), eq(auditLog.resourceType, "zone")),
        zoneResourceScope(serverSlug, zoneName),
      ),
    )
    .groupBy(auditLog.action);
  const out = {
    recordCreate: 0,
    recordUpdate: 0,
    recordDelete: 0,
    notify: 0,
    metadata: 0,
    settings: 0,
    dnssec: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += r.n;
    if (r.action === "record.create") out.recordCreate += r.n;
    else if (r.action === "record.update") out.recordUpdate += r.n;
    else if (r.action === "record.delete") out.recordDelete += r.n;
    else if (r.action === "zone.notify") out.notify += r.n;
    else if (r.action.startsWith("zone.metadata.")) out.metadata += r.n;
    else if (r.action === "zone.settings.update") out.settings += r.n;
    else if (r.action.startsWith("dnssec.cryptokey.")) out.dnssec += r.n;
  }
  return out;
}

export async function latestZoneEdit(
  serverSlug: string,
  zoneName: string,
): Promise<ZoneAuditEntry | null> {
  const rows = await db
    .select({
      id: castToText(auditLog.id),
      ts: auditLog.ts,
      actorType: auditLog.actorType,
      actorEmail: users.email,
      actorName: users.name,
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      before: auditLog.before,
      after: auditLog.after,
      ip: castToNullableText(auditLog.ip),
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        or(eq(auditLog.resourceType, "rrset"), eq(auditLog.resourceType, "zone")),
        zoneResourceScope(serverSlug, zoneName),
        // Exclude the notify side-effect rows from "what was the
        // last real edit" — they aren't operator actions, just
        // automated downstream effects of the actual writes.
        sql`${auditLog.action} <> 'zone.notify'`,
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Batched "last edit timestamp" for a set of zones on one backend
 *. Used by the zones list to render a "Last edit" column
 * without N+1 queries. Same scope rules as `latestZoneEdit`:
 * resourceType in {rrset, zone}, resourceId prefixed `${slug}:`,
 * `zone.notify` excluded.
 *
 * One round-trip — Postgres groups by the zone segment extracted
 * with `split_part(resource_id, ':', 2)`. Zone names can't contain
 * `:` (DNS labels disallow it) so the split is unambiguous. Returns
 * a `Map<zoneName, Date>`; zones with no recorded edits are absent
 * from the map (caller renders "—").
 *
 * Empty input → empty map, no DB call.
 */
export async function latestEditTimestampsByZone(
  serverSlug: string,
  zoneNames: readonly string[],
): Promise<Map<string, Date>> {
  if (zoneNames.length === 0) return new Map();

  // Group by the raw `resource_id` column (always equivalent in both
  // dialects), then split + reduce in JS. The previous incarnation
  // grouped by a computed `split_part(...)` expression which Postgres
  // accepted in earlier Drizzle versions but now flags
  // ("column must appear in GROUP BY clause") because the generated
  // SQL re-emits the column reference without the wrapping function.
  // Aggregating in app code is cheap — rows are already partitioned
  // by the `serverSlug:` prefix in the WHERE.
  // Scope to this server's rows only (the JS reducer below splits out the zone
  // segment). Escape the slug + declare `ESCAPE '\'` so a slug containing `_`
  // or `%` can't wildcard-match a sibling server's rows; portable across PG
  // (backslash is its default) and SQLite (no default escape char).
  const serverPattern = `${escapeLikePattern(serverSlug)}:%`;
  const rows = await db
    .select({
      resourceId: auditLog.resourceId,
      lastTs: sql<Date>`max(${auditLog.ts})`,
    })
    .from(auditLog)
    .where(
      and(
        or(eq(auditLog.resourceType, "rrset"), eq(auditLog.resourceType, "zone")),
        sql`${auditLog.resourceId} LIKE ${serverPattern} ESCAPE '\\'`,
        sql`${auditLog.action} <> 'zone.notify'`,
      ),
    )
    .groupBy(auditLog.resourceId);

  const wanted = new Set(zoneNames);
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (!r.resourceId) continue;
    // resourceId shapes:
    //   zone:   `${serverSlug}:${zoneName}`
    //   rrset:  `${serverSlug}:${zoneName}:${rrsetName}|${rrsetType}`
    // Extract the zone segment (everything after the first colon up to
    // the next colon, or end-of-string).
    const firstColon = r.resourceId.indexOf(":");
    if (firstColon === -1) continue;
    const rest = r.resourceId.slice(firstColon + 1);
    const nextColon = rest.indexOf(":");
    const zoneName = nextColon === -1 ? rest : rest.slice(0, nextColon);
    if (!wanted.has(zoneName)) continue;
    const ts = coerceDate(r.lastTs);
    const existing = out.get(zoneName);
    if (!existing || existing < ts) out.set(zoneName, ts);
  }
  return out;
}

/**
 * Latest audit row for a single PDNS-server admin row.
 * Mirrors `latestZoneEdit` shape but scoped to admin actions on
 * the server's own row (server.update / server.delete / the test-
 * probe oidc.provider.updated-style audit rows). Used by the
 * server-detail header to show "Last admin edit: 2h ago by alice@…".
 *
 * Resource type is "pdns_server" and resourceId is the server's
 * UUID (the admin routes write these directly; the test-route
 * audit also uses that resource shape). Returns null
 * when the server has no recorded admin edits.
 */
export async function latestServerAdminEdit(serverId: string): Promise<ZoneAuditEntry | null> {
  return latestAdminEditByResource("pdns_server", serverId);
}

/**
 * Latest audit row for a single OIDC-provider admin row.
 * Same shape as `latestServerAdminEdit` — wraps the shared helper
 * with the OIDC `resourceType` literal so callers don't have to
 * remember the magic string.
 */
export async function latestOidcProviderEdit(providerId: string): Promise<ZoneAuditEntry | null> {
  return latestAdminEditByResource("oidc_provider", providerId);
}

/**
 * Recent audit rows scoped to a single admin resource.
 * Returns up to `limit` rows newest-first. Used by the per-resource
 * audit panel on detail pages — gives operators a small window
 * into "what's been happening with this row" without leaving the
 * detail page for /admin/audit. The same private
 * `latestAdminEditByResource` knows the SQL shape; this variant
 * just removes the `LIMIT 1` and parameterizes limit.
 */
export async function recentAdminEditsForServer(
  serverId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("pdns_server", serverId, limit);
}

export async function recentAdminEditsForOidcProvider(
  providerId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("oidc_provider", providerId, limit);
}

/** Role / team / zone-template wrappers. Same shape. */
export async function recentAdminEditsForRole(
  roleId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("role", roleId, limit);
}

export async function recentAdminEditsForTeam(
  teamId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("team", teamId, limit);
}

export async function recentAdminEditsForZoneTemplate(
  templateId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("zone_template", templateId, limit);
}

/**
 * Recent admin activity for a single user. Covers the admin-driven
 * actions written with `resource.type = "user"` — user.create,
 * user.update, user.disable, user.enable, user.delete,
 * user.password.reset, user.session(s).revoked, plus the auth.* rows
 * that the admin user-actions write (auth.mfa.removed by admin,
 * auth.token.revoked by admin, auth.password.changed, etc.). The
 * `user.read`-gated user detail page renders this for incident-
 * response visibility.
 */
export async function recentAdminEditsForUser(
  userId: string,
  limit = 10,
): Promise<ZoneAuditEntry[]> {
  return recentAdminEditsByResource("user", userId, limit);
}

/**
 * Recent `dnssec.cryptokey.*` audit rows scoped to a zone (Tick
 * 81). Used by the zone DNSSEC page to surface "last activity"
 * per key card. Caller buckets by the `cryptokeyId` carried in
 * before/after — the audit row's resourceId is the zone name, not
 * the key id, since one zone has many keys and the existing audit
 * writers (/3 era) scoped to the parent zone.
 *
 * Returns up to `limit` rows newest-first. Default 200 comfortably
 * covers "what's happened to keys lately" for any realistic key
 * churn rate without paginating.
 *
 * Resource-id shape: brought cryptokey audit writers in
 * line with the rrset convention (`${serverSlug}:${zoneName}`).
 * This reader matches BOTH the new prefixed form and the bare
 * `zoneName` form so audit rows written before T-83 still surface.
 * Drop the bare-form branch once historical rows are no longer
 * relevant (or a one-time backfill migration is run).
 */
export async function recentDnssecAuditForZone(
  serverSlug: string,
  zoneName: string,
  limit = 200,
): Promise<ZoneAuditEntry[]> {
  const prefixed = `${serverSlug}:${zoneName}`;
  return db
    .select({
      id: castToText(auditLog.id),
      ts: auditLog.ts,
      actorType: auditLog.actorType,
      actorEmail: users.email,
      actorName: users.name,
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      before: auditLog.before,
      after: auditLog.after,
      ip: castToNullableText(auditLog.ip),
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(
      and(
        eq(auditLog.resourceType, "zone"),
        or(eq(auditLog.resourceId, prefixed), eq(auditLog.resourceId, zoneName)),
        like(auditLog.action, "dnssec.cryptokey.%"),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(limit);
}

/**
 * Shared internal helper for "latest audit row for a single admin
 * resource id." Both `latestServerAdminEdit` and
 * `latestOidcProviderEdit` are now one-liners delegating here;
 * future resource types (role, team, zone-template) drop in with
 * the same shape. Kept private to discourage callers using a raw
 * resourceType string — the typed wrappers are the supported
 * surface.
 */
async function latestAdminEditByResource(
  resourceType: string,
  resourceId: string,
): Promise<ZoneAuditEntry | null> {
  const rows = await recentAdminEditsByResource(resourceType, resourceId, 1);
  return rows[0] ?? null;
}

/**
 * Shared internal selector: newest-first audit rows for a single
 * admin resource. Both the "latest one" (`latestAdminEditByResource`)
 * and the "recent N" wrappers (`recentAdminEditsFor*`) share this
 * SQL — keeps the join + projection in one place.
 */
async function recentAdminEditsByResource(
  resourceType: string,
  resourceId: string,
  limit: number,
): Promise<ZoneAuditEntry[]> {
  return db
    .select({
      id: castToText(auditLog.id),
      ts: auditLog.ts,
      actorType: auditLog.actorType,
      actorEmail: users.email,
      actorName: users.name,
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      before: auditLog.before,
      after: auditLog.after,
      ip: castToNullableText(auditLog.ip),
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(and(eq(auditLog.resourceType, resourceType), eq(auditLog.resourceId, resourceId)))
    .orderBy(desc(auditLog.ts))
    .limit(limit);
}

/**
 * Batched "latest admin-edit timestamp" for a list of admin
 * resource ids of one type. Mirrors T-87's
 * `latestEditTimestampsByZone` but parameterized on resourceType
 * so it works for `pdns_server`, `oidc_provider`, `role`, `team`,
 * `zone_template`, `user` — any admin resource whose audit rows
 * use the resourceType + UUID convention.
 *
 * Single round-trip; one MAX(ts) per resource id. Empty input
 * short-circuits with no DB call. Returns a Map keyed by
 * resourceId; ids with no recorded edits are absent (caller
 * renders "—").
 *
 * Kept generic + private-friendly: typed wrappers (e.g.
 * `latestAdminEditTimestampsForServers`) own the resourceType
 * literal so callers don't have to.
 */
export async function latestAdminEditTimestampsByResource(
  resourceType: string,
  resourceIds: readonly string[],
): Promise<Map<string, Date>> {
  if (resourceIds.length === 0) return new Map();

  const rows = await db
    .select({
      resourceId: auditLog.resourceId,
      lastTs: sql<Date>`max(${auditLog.ts})`,
    })
    .from(auditLog)
    .where(
      and(eq(auditLog.resourceType, resourceType), inArray(auditLog.resourceId, [...resourceIds])),
    )
    .groupBy(auditLog.resourceId);

  const out = new Map<string, Date>();
  for (const r of rows) {
    if (r.resourceId !== null) out.set(r.resourceId, coerceDate(r.lastTs));
  }
  return out;
}

/** Typed wrapper for the PDNS-server admin list. */
export async function latestAdminEditTimestampsForServers(
  serverIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("pdns_server", serverIds);
}

/** Typed wrapper for the users admin list. */
export async function latestAdminEditTimestampsForUsers(
  userIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("user", userIds);
}

/** Typed wrappers for the remaining admin lists. */
export async function latestAdminEditTimestampsForTeams(
  teamIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("team", teamIds);
}

export async function latestAdminEditTimestampsForRoles(
  roleIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("role", roleIds);
}

export async function latestAdminEditTimestampsForOidcProviders(
  providerIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("oidc_provider", providerIds);
}

export async function latestAdminEditTimestampsForZoneTemplates(
  templateIds: readonly string[],
): Promise<Map<string, Date>> {
  return latestAdminEditTimestampsByResource("zone_template", templateIds);
}
