/**
 * app/api/realtime/route.ts
 *
 * Single app-wide Server-Sent Events stream. One connection per
 * browser carries every event type the user is permitted to see;
 * subscribers throughout the React tree filter client-side via the
 * realtime context.
 *
 * Replaces the four per-channel endpoints (/api/realtime/zone,
 * /api/realtime/server, /api/realtime/audit, /api/realtime/pdns-requests)
 * — operators noticed dozens of EventSource connections opening per
 * page (one per indicator) and an explosion of router.refresh() bursts
 * driven by uncoordinated subscribers.
 *
 * Permissions: client-side filtering trusts only the events the bus
 * emits, but we still strip sensitive event types before delivery for
 * users without the matching read permission (audit/pdns-requests
 * leak action vocabulary, actor IDs, URLs — gated by audit.read).
 */

import { requireUser } from "@/lib/auth/require-user";
import { subscribeAll, type RealtimeEvent } from "@/lib/realtime/event-bus";
import { registerPollerSubscriber } from "@/lib/realtime/zone-poller";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Per-user concurrent-stream cap. Each SSE connection holds a Node socket,
 * a heartbeat interval, and a bus listener; without a cap an authenticated
 * client could open many long-lived streams and pin resources. Tracked on
 * `globalThis` so HMR/module reloads don't strand the counter.
 */
declare global {
  var __pdnsRealtimeConns: Map<string, number> | undefined;
}
const conns = (globalThis.__pdnsRealtimeConns ??= new Map<string, number>());
const MAX_CONNS_PER_USER = 8;

/** Canonical zone name (lowercase + trailing dot) for grant matching. */
function canonicalZone(z: string): string {
  const lower = z.trim().toLowerCase();
  return lower.endsWith(".") ? lower : `${lower}.`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { user, globalPermissions, zoneGrants } = await requireUser();
    const globalZoneRead = globalPermissions.has("zone.read");
    // Stream is useful only if the user can read SOME zone — globally or via
    // a zone_grant. A type-level `ability.can("read","Zone")` would admit a
    // team-scoped role and then leak every zone's events; see
    // lib/rbac/ability.ts:globalPermissionsOf.
    if (!globalZoneRead && zoneGrants.length === 0) {
      throw new ForbiddenError("Missing zone.read.");
    }
    const canReadAudit = globalPermissions.has("audit.read");

    // Per-user connection cap.
    const active = conns.get(user.id) ?? 0;
    if (active >= MAX_CONNS_PER_USER) {
      return Response.json(
        { error: "Too many concurrent realtime streams." },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }

    // For non-global users, the set of zones whose events they may receive,
    // keyed `serverSlug:canonicalZoneName`. Grants carry serverId, events
    // carry serverSlug, so resolve the mapping once at connect time.
    const grantKeys = new Set<string>();
    if (!globalZoneRead) {
      const servers = await listAllPdnsServers();
      const slugById = new Map(servers.map((s) => [s.id, s.slug]));
      for (const g of zoneGrants) {
        const slug = slugById.get(g.serverId);
        if (slug) grantKeys.add(`${slug}:${canonicalZone(g.zoneName)}`);
      }
    }

    conns.set(user.id, active + 1);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          stopPoller();
          const remaining = (conns.get(user.id) ?? 1) - 1;
          if (remaining <= 0) conns.delete(user.id);
          else conns.set(user.id, remaining);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        const unsubscribe = subscribeAll((event: RealtimeEvent) => {
          if (closed) return;
          // Drop sensitive events for users without audit.read — they
          // leak actor IDs, action vocabulary, request URLs.
          if (
            (event.type === "audit.appended" || event.type === "pdns.request.appended") &&
            !canReadAudit
          ) {
            return;
          }
          // Per-zone scoping: a non-global user only receives zone events
          // for zones they hold a grant on. Without this, zone names +
          // serials on every backend leak to any scoped user.
          if (
            !globalZoneRead &&
            (event.type === "zone.updated" || event.type === "zone.sync.changed") &&
            !grantKeys.has(`${event.serverSlug}:${canonicalZone(event.zone)}`)
          ) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Stream is gone — self-clean so we don't leak this
            // listener if `abort` never fires (server crash mid-
            // stream, hung connection, etc.). Without this, dead
            // listeners would accumulate in the bus and call
            // enqueue on every event forever.
            cleanup();
          }
        });
        const stopPoller = registerPollerSubscriber();
        const heartbeat = setInterval(() => {
          if (closed) {
            clearInterval(heartbeat);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`));
          } catch {
            cleanup();
          }
        }, 25_000);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`,
          ),
        );
        request.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
