/**
 * lib/db/repositories/pdns-requests.ts
 *
 * Reads against `pdns_requests`. Used by the change-history feed and the
 * audit-log viewer to surface the raw HTTP traffic that backed an
 * operation. The writer lives in `lib/pdns/request-log.ts`.
 */

import "server-only";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pdnsRequests, type PdnsRequestRow } from "@/lib/db/schema";

/**
 * Batched variant for views that render many audit rows at once (the
 * change-history feed). Returns a Map keyed by requestId; missing keys
 * mean "no PDNS calls logged for that operation" (the row may be from
 * before this table existed, or a non-PDNS audit event).
 */
export async function findPdnsRequestsByRequestIds(
  requestIds: readonly string[],
): Promise<Map<string, PdnsRequestRow[]>> {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(pdnsRequests)
    .where(inArray(pdnsRequests.requestId, [...requestIds]))
    .orderBy(asc(pdnsRequests.ts));
  const grouped = new Map<string, PdnsRequestRow[]>();
  for (const row of rows) {
    if (!row.requestId) continue;
    const list = grouped.get(row.requestId) ?? [];
    list.push(row);
    grouped.set(row.requestId, list);
  }
  return grouped;
}
