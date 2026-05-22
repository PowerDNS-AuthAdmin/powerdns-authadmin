/**
 * lib/db/repositories/audit.ts
 *
 * Read access to the append-only audit log. The writer lives in
 * `lib/audit/log.ts` — this module only exposes the query surface used by the
 * admin audit viewer.
 *
 * Filters are applied as a conjunction (AND). The page renders pagination via
 * limit/offset; cursor-based pagination lands when the audit dataset gets
 * large enough to matter.
 */

import "server-only";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, type AuditEntry } from "@/lib/db/schema";
import { users } from "@/lib/db/schema";
import { castToText, countStar } from "@/lib/db/sql-dialect";
import { escapeLikePattern } from "./audit-like";

/**
 * Audit row enriched with the actor's email. The dashboard's
 * `recentAudit` helper used to be the only consumer of this shape;
 * hoisted it here so the full audit page and CSV export
 * carry the email too — operators triage rows by who-did-what far
 * more often than by actor UUID.
 *
 * `actorEmail` is null when the actor row was deleted (cascading
 * actor IDs is not cascaded — audit history is intentionally
 * preserved past user-deletion) or when the actor was non-user
 * (system / token).
 */
export type AuditEntryWithActor = AuditEntry & { actorEmail: string | null };

export interface AuditQueryFilters {
  /** Restrict to a single actor uuid (typically a user id). */
  actorId?: string;
  /** Restrict to one of "user" / "token" / "system". */
  actorType?: "user" | "token" | "system";
  /** Exact action match (e.g. "auth.login.success"). */
  action?: string;
  /** Resource type slug (e.g. "user", "pdns_server"). */
  resourceType?: string;
  /** Resource id exact match. */
  resourceId?: string;
  /**
   * Request id (`x-request-id` value from the middleware) exact
   * match. Useful for joining audit rows back to a specific HTTP
   * request when investigating an incident — operators paste the
   * id from a log line or error toast. Not indexed today; equality
   * scan is fine at audit-log scale.
   */
  requestId?: string;
  /** Inclusive lower bound on `ts`. */
  from?: Date;
  /** Inclusive upper bound on `ts`. */
  to?: Date;
  /**
   * Free-text search across action, resource_type, resource_id,
   * actor_id, and the JSON-stringified `before`/`after` payloads.
   * Case-insensitive ILIKE; user input is escaped so `_` and `%`
   * become literal characters.
   *
   * No GIN/tsvector index on the columns today — a sequential
   * scan is fine at sub-million row counts (the audit viewer is
   * an admin-only surface, not a hot path). When the table grows,
   * add a generated tsvector + GIN index migration; the repo
   * surface stays the same.
   */
  q?: string;
}

export interface AuditPage {
  entries: AuditEntryWithActor[];
  total: number;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Page over audit entries newest-first with optional filters. Returns the
 * page slice plus a total count for the matching set so the UI can render
 * "N of M".
 */
export async function queryAuditLog(
  filters: AuditQueryFilters = {},
  pagination: { limit?: number; offset?: number } = {},
): Promise<AuditPage> {
  const limit = Math.min(pagination.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(pagination.offset ?? 0, 0);
  const where = buildWhereClause(filters);

  // Left-join `users` so we can project `actor_email` alongside the
  // audit row. Left because the actor may be a system / token row
  // (no users-table mapping) or a deleted user (actor IDs aren't
  // cascaded; the audit history outlives the user row deliberately).
  const baseQuery = db
    .select({ row: auditLog, actorEmail: users.email })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id));
  const filtered = where ? baseQuery.where(where) : baseQuery;
  const rawEntries = await filtered.orderBy(desc(auditLog.ts)).limit(limit).offset(offset);
  const entries: AuditEntryWithActor[] = rawEntries.map((r) => ({
    ...r.row,
    actorEmail: r.actorEmail,
  }));

  const countBase = db.select({ count: countStar() }).from(auditLog);
  const totalRows = await (where ? countBase.where(where) : countBase);
  const total = totalRows[0]?.count ?? 0;

  return { entries, total, limit, offset };
}

/**
 * Stream audit rows for a CSV export. Same filters as `queryAuditLog`
 * but no `total` count (saves a second pass) and a higher row cap
 * suitable for compliance / incident exports.
 *
 * `maxRows` defaults to 10,000 and is hard-capped at the same. We
 * could chunk further if operators ever need to export more, but
 * 10k rows of audit at the typical row size (~1 KB) is ~10 MB —
 * already the practical ceiling for a single browser download
 * without paging.
 */
const EXPORT_HARD_CAP = 10_000;
export async function listAuditForExport(
  filters: AuditQueryFilters = {},
  maxRows = EXPORT_HARD_CAP,
): Promise<AuditEntryWithActor[]> {
  const limit = Math.min(Math.max(maxRows, 1), EXPORT_HARD_CAP);
  const where = buildWhereClause(filters);
  const baseQuery = db
    .select({ row: auditLog, actorEmail: users.email })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id));
  const filtered = where ? baseQuery.where(where) : baseQuery;
  const rows = await filtered.orderBy(desc(auditLog.ts)).limit(limit);
  return rows.map((r) => ({ ...r.row, actorEmail: r.actorEmail }));
}

function buildWhereClause(filters: AuditQueryFilters): SQL | undefined {
  const parts: SQL[] = [];
  if (filters.actorId) parts.push(eq(auditLog.actorId, filters.actorId));
  if (filters.actorType) parts.push(eq(auditLog.actorType, filters.actorType));
  if (filters.action) parts.push(eq(auditLog.action, filters.action));
  if (filters.resourceType) parts.push(eq(auditLog.resourceType, filters.resourceType));
  if (filters.resourceId) parts.push(eq(auditLog.resourceId, filters.resourceId));
  if (filters.requestId) parts.push(eq(auditLog.requestId, filters.requestId));
  if (filters.from) parts.push(gte(auditLog.ts, filters.from));
  if (filters.to) parts.push(lte(auditLog.ts, filters.to));
  if (filters.q) {
    // Case-insensitive substring match across the searchable columns.
    // Lowercasing both sides keeps this dialect-neutral — PG would use ILIKE,
    // SQLite has case-insensitive LIKE for ASCII by default but not Unicode,
    // so explicit `lower()` is the portable form.
    const pattern = `%${escapeLikePattern(filters.q).toLowerCase()}%`;
    const actorIdText = castToText(auditLog.actorId);
    const beforeText = castToText(auditLog.before);
    const afterText = castToText(auditLog.after);
    // `escapeLikePattern` backslash-escapes %/_/\, but SQLite's LIKE has NO
    // default escape char, so the escapes are inert (and the backslashes leak
    // through as literals) unless we declare one. `ESCAPE '\'` is portable:
    // Postgres already treats backslash as the default LIKE escape, so this is
    // a no-op there and turns the escaping on for SQLite.
    const esc = sql.raw(`ESCAPE '\\'`);
    parts.push(sql`(
      lower(${auditLog.action}) LIKE ${pattern} ${esc}
      OR lower(${auditLog.resourceType}) LIKE ${pattern} ${esc}
      OR lower(coalesce(${auditLog.resourceId}, '')) LIKE ${pattern} ${esc}
      OR lower(coalesce(${actorIdText}, '')) LIKE ${pattern} ${esc}
      OR lower(coalesce(${beforeText}, '')) LIKE ${pattern} ${esc}
      OR lower(coalesce(${afterText}, '')) LIKE ${pattern} ${esc}
    )`);
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}
