/**
 * app/api/admin/pdns/zones/[zoneId]/sync/route.ts
 *
 * GET ?serverSlug= - where one zone's copies stand: for a primary with
 * secondaries, each secondary's serial against the primary's; for a cluster,
 * each peer against the highest serial among them, plus the cluster's
 * secondaries. `settled` is true when nothing is behind, which is what the
 * Add record wizard waits for before it lets the operator finish, and what
 * an MCP client can poll after a write. Serials come from the poller's
 * zone-state cache (warmed on demand), so this never fans out to every
 * backend per call.
 * Permission: `zone.read` on the zone.
 */

import { requireUser } from "@/lib/auth/require-user";
import { listActivePeersForCluster } from "@/lib/db/repositories/pdns-clusters";
import {
  findDefaultPdnsServer,
  findPdnsServerBySlug,
  listClusterSecondaries,
} from "@/lib/db/repositories/pdns-servers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { redact } from "@/lib/errors/redact";
import { errorResponse } from "@/lib/http/error-response";
import { normalizeZoneId } from "@/lib/pdns/client";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { isSettledSyncState, type SyncState } from "@/lib/pdns/serial-sync";
import { checkZoneSync } from "@/lib/pdns/sync";
import { readCachedZone } from "@/lib/pdns/zone-state-cache";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { canActOnZone } from "@/lib/rbac/zone-permissions";

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export interface ZoneSyncMember {
  slug: string;
  name: string;
  role: "primary" | "peer" | "secondary";
  state: SyncState | "unknown";
  serial: number | null;
  /** The serial this member should hold (the primary's, or the cluster's highest). */
  expectedSerial: number | null;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const auth = await requireUser();
    const { zoneId } = await context.params;
    const zone = normalizeZoneId(decodeURIComponent(zoneId));
    const slug = new URL(request.url).searchParams.get("serverSlug");
    const server = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
    if (server?.disabledAt !== null)
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    const allowed = canActOnZone(auth, {
      serverId: server.id,
      zoneName: zone,
      permission: "zone.read",
    });
    if (!allowed) throw new ForbiddenError("Missing zone.read for this zone.");

    await ensureBackendsObserved();
    let detail;
    try {
      detail = await getBackendGateway(server).getZone(zone, { rrsets: false });
    } catch (err) {
      if (err instanceof PdnsNotFoundError)
        throw new NotFoundError(`Zone "${zone}" not found on backend.`);
      if (err instanceof PdnsError) throw new ValidationError(`PDNS: ${redact(err.message)}`);
      throw err;
    }
    const members: ZoneSyncMember[] = [];
    let topology: "standalone" | "primary-secondaries" | "cluster" = "standalone";

    if (server.clusterId) {
      topology = "cluster";
      const peers = await listActivePeersForCluster(server.clusterId);
      const serials = peers.map((p) => readCachedZone(p.id, zone)?.serial ?? null);
      const highest = serials.reduce<number | null>(
        (m, s) => (s !== null && (m === null || s > m) ? s : m),
        null,
      );
      peers.forEach((p, i) => {
        const serial = serials[i] ?? null;
        members.push({
          slug: p.slug,
          name: p.name,
          role: "peer",
          state: serial === null ? "unknown" : serial === highest ? "in-sync" : "lagging",
          serial,
          expectedSerial: highest,
        });
      });
      const secondaries = await listClusterSecondaries(server.clusterId);
      if (secondaries.length > 0) {
        for (const s of await checkZoneSync(server, detail)) {
          members.push({
            slug: s.server.slug,
            name: s.server.name,
            role: "secondary",
            state: s.state,
            serial: s.secondarySerial,
            expectedSerial: s.primarySerial,
          });
        }
      }
    } else {
      const statuses = await checkZoneSync(server, detail);
      members.push({
        slug: server.slug,
        name: server.name,
        role: "primary",
        state: "in-sync",
        serial: detail.serial ?? null,
        expectedSerial: detail.serial ?? null,
      });
      if (statuses.length > 0) topology = "primary-secondaries";
      for (const s of statuses) {
        members.push({
          slug: s.server.slug,
          name: s.server.name,
          role: "secondary",
          state: s.state,
          serial: s.secondarySerial,
          expectedSerial: s.primarySerial,
        });
      }
    }
    const settled = members.every((m) => m.state !== "unknown" && isSettledSyncState(m.state));
    return Response.json({
      zone,
      server: server.slug,
      topology,
      members,
      settled,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(err, "zones.sync.error");
  }
}
