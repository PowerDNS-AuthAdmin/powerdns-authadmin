/**
 * app/api/admin/monitoring/zones/_viewer.ts
 *
 * Marks each monitoring result with whether the viewer may change that zone's
 * SOA, so the bulk "Fix all" review can list the zones it will skip before
 * anything is written. The monitoring routes only need global `zone.read`;
 * the write itself still goes through the RRset route, which checks
 * `soa.update` per zone again and is the authority.
 */

import "server-only";
import type { AuthenticatedRequest } from "@/lib/auth/get-current-user";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import type { ZoneMonitorResult } from "@/lib/monitoring/zone-monitor";
import { canActOnZone } from "@/lib/rbac/zone-permissions";

export async function withViewerPermissions(
  results: readonly ZoneMonitorResult[],
  auth: AuthenticatedRequest,
): Promise<ZoneMonitorResult[]> {
  if (results.length === 0) return [];
  // A global holder skips the backend lookup.
  if (auth.globalPermissions.has("soa.update"))
    return results.map((r) => ({ ...r, canUpdateSoa: true }));
  const idBySlug = new Map((await listAllActiveBackends()).map((s) => [s.slug, s.id]));
  return results.map((r) => {
    const serverId = idBySlug.get(r.server);
    return {
      ...r,
      canUpdateSoa:
        serverId !== undefined &&
        canActOnZone(auth, { serverId, zoneName: r.zone, permission: "soa.update" }),
    };
  });
}
