/**
 * app/api/admin/pdns/auto-ptr/report/route.ts
 *
 * GET - the fleet-wide reverse DNS diff for the Reverse DNS page: every A/AAAA
 * record against the PTR in the hosted reverse zones. Permission: global
 * `record.read` (it reads every zone, so a per-zone grant is not enough).
 * No audit row: it is a read. `?refresh=1` asks for a fresh scan (rate-limited
 * in `_scan.ts`); otherwise a scan up to a minute old is reused.
 */

import { requireUser } from "@/lib/auth/require-user";
import { reconcilePtrs } from "@/lib/dns/ptr-reconcile";
import { errorResponse } from "@/lib/http/error-response";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { getExternalPtr, scheduleExternalLookups } from "@/lib/monitoring/external-ptr";
import { getFleetScan } from "../_scan";
import { requireFeature } from "@/lib/http/require-feature";

const scanAt = (scan: { at?: number }): number => scan.at ?? Date.now();

export async function GET(request: Request): Promise<Response> {
  try {
    requireFeature("reverseDns");
    const { globalPermissions, zoneGrants } = await requireUser({ can: "record.read" });
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const scan = await getFleetScan({ refresh });
    const bySlug = new Map(scan.servers.map((s) => [s.slug, s]));
    const canWriteReverse = (zone: string, serverSlug: string): boolean => {
      const server = bySlug.get(serverSlug);
      if (!server) return false;
      const can = (permission: string): boolean =>
        canActOnZone({
          hasGlobalPermission: globalPermissions.has(permission),
          grants: zoneGrants,
          serverId: server.id,
          zoneName: zone,
          permission,
        });
      return can("record.create") || can("record.update");
    };
    const { rows, stats } = reconcilePtrs({
      forward: scan.forward,
      reverse: scan.reverse,
      hostedReverseZones: scan.hostedReverseZones,
      canWriteReverse,
    });
    // Addresses nobody here can host still get an answer from the world: the
    // background lookup fills them in over the next interval, and the rows carry
    // whatever is known so far.
    const unhosted = rows.filter((r) => r.status === "unhosted");
    scheduleExternalLookups(unhosted.map((r) => ({ ip: r.ip, horizon: r.horizon })));
    const withExternal = rows.map((r) => {
      if (r.status !== "unhosted") return r;
      const ext = getExternalPtr(r.ip);
      if (!ext) return { ...r, external: { status: "pending" as const } };
      const names = new Set(r.forward.map((f) => f.name));
      const status = ext.error
        ? ("error" as const)
        : ext.targets.length === 0
          ? ("none" as const)
          : ext.targets.some((t) => names.has(t.toLowerCase()))
            ? ("match" as const)
            : ("mismatch" as const);
      return {
        ...r,
        external: {
          status,
          targets: ext.targets,
          resolver: ext.resolver,
          checkedAt: ext.checkedAt,
          ...(ext.error ? { error: ext.error } : {}),
        },
      };
    });
    return Response.json({
      generatedAt: new Date(scanAt(scan)).toISOString(),
      backends: scan.backends,
      reverseZones: scan.hostedReverseZones,
      rows: withExternal,
      stats: { ...stats, zonesScanned: scan.zonesScanned, recordsScanned: scan.recordsScanned },
      errors: scan.errors,
    });
  } catch (err) {
    return errorResponse(err, "auto-ptr.report.error");
  }
}
