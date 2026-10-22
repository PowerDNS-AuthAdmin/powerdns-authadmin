/**
 * app/api/admin/pdns/zones/search/route.ts
 *
 * GET ?q=&horizon=&limit= - the zones the caller may read, across every
 * backend, for type-ahead pickers (the Add record wizard, MCP `find_zones`).
 * Answered from the shared fleet scan, so it is cheap; each zone carries its
 * backend, cluster, horizon and whether the caller may create records in it.
 */

import { requireUser } from "@/lib/auth/require-user";
import { findClusterById } from "@/lib/db/repositories/pdns-clusters";
import { zoneKind } from "@/lib/dns/zone-kind";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { getFleetScan } from "../../auto-ptr/_scan";

export interface ZoneSearchHit {
  name: string;
  server: string;
  serverName: string;
  cluster: string | null;
  horizon: "public" | "internal";
  kind: string;
  reverse: boolean;
  canCreate: boolean;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireUser();
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (q.length > 255) throw new ValidationError("Query too long.");
    const horizon = url.searchParams.get("horizon");
    if (horizon && horizon !== "public" && horizon !== "internal")
      throw new ValidationError("Invalid horizon.");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

    const scan = await getFleetScan();
    const bySlug = new Map(scan.servers.map((s) => [s.slug, s]));
    const clusterSlugs = new Map<string, string | null>();
    const clusterSlugOf = async (clusterId: string | null): Promise<string | null> => {
      if (!clusterId) return null;
      if (!clusterSlugs.has(clusterId))
        clusterSlugs.set(clusterId, (await findClusterById(clusterId))?.slug ?? null);
      return clusterSlugs.get(clusterId) ?? null;
    };
    const can = (permission: string, serverId: string, zone: string): boolean =>
      canActOnZone(auth, { serverId, zoneName: zone, permission });

    const totals = { public: 0, internal: 0 };
    const hits: ZoneSearchHit[] = [];
    const seen = new Set<string>();
    for (const z of scan.zones) {
      const server = bySlug.get(z.server);
      if (!server || !can("zone.read", server.id, z.name)) continue;
      const key = `${z.server}|${z.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      totals[z.horizon]++;
      if (horizon && z.horizon !== horizon) continue;
      if (q && !z.name.includes(q)) continue;
      hits.push({
        name: z.name,
        server: z.server,
        serverName: server.name,
        cluster: await clusterSlugOf(server.clusterId),
        horizon: z.horizon,
        kind: z.kind,
        reverse: zoneKind(z.name) !== "forward",
        canCreate: can("record.create", server.id, z.name),
      });
    }
    // Prefix matches first, then alphabetical, so typing "exa" surfaces example.com. before an-example.net.
    hits.sort(
      (a, b) =>
        Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name),
    );
    return Response.json({ zones: hits.slice(0, limit), total: hits.length, horizons: totals });
  } catch (err) {
    return errorResponse(err, "zones.search.error");
  }
}
