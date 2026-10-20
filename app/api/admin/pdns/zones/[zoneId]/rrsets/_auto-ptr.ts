/**
 * app/api/admin/pdns/zones/[zoneId]/rrsets/_auto-ptr.ts
 *
 * Automatic PTR maintenance (issue #164): after an A/AAAA RRset change has
 * been written to its forward zone, upsert or remove the matching PTRs in the
 * reverse zones this installation hosts. The decisions are made by the pure
 * planner in `lib/dns/auto-ptr.ts`; this module does the reads, the permission
 * checks, the writes and the audit rows, and runs the exact same code in
 * `dryRun` mode for the editor's review modal.
 *
 * Why it lives next to the route rather than in `lib/pdns`: it combines RBAC,
 * audit and PowerDNS access, which that layer deliberately keeps above it.
 *
 * Design points that differ from the legacy tool's `auto_ptr`:
 *   - The reverse zone is never created; a missing one is a visible skip.
 *   - Forward and reverse are two PATCHes. The forward write has already
 *     succeeded when this runs, and a PTR failure never rolls it back: it is
 *     reported per address, audited, and left for the operator to retry.
 *   - A PTR that points at another name is never overwritten unless the change
 *     carries `ptrTakeover`.
 *   - The caller must be allowed to write records in the reverse zone (global
 *     permission or a grant on that zone); otherwise the PTR is skipped, not
 *     written on their behalf.
 *   - The reverse zone's backend is chosen as the forward zone's backend when it
 *     hosts the zone, else a peer of the same cluster, else the first backend
 *     that hosts it writably; read-only backends and secondary copies are
 *     never written.
 */

import { appendAudit } from "@/lib/audit/log";
import type { PdnsServer } from "@/lib/db/schema";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import {
  candidatePtrOwners,
  describePtrOutcome,
  planPtrChanges,
  type AddressChange,
  type AddressRecord,
  type AutoPtrOutcome,
  type ExistingPtr,
} from "@/lib/dns/auto-ptr";
import {
  resolveAutoPtr,
  zoneAutoPtrFromMetadata,
  type ResolvedAutoPtr,
} from "@/lib/dns/auto-ptr-setting";
import { canonicalZone } from "@/lib/dns/reverse-name";
import { isReverseZone } from "@/lib/dns/zone-kind";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import type { PdnsClient } from "@/lib/pdns/client";
import { notifyZoneBestEffort } from "@/lib/pdns/operations";
import { deleteRRset, replaceRRset, zonePatchBody, type RRsetPatch } from "@/lib/pdns/rrsets";
import { isReadOnlyZoneKind } from "@/lib/pdns/writable-kind";
import { isTransferredKind } from "@/lib/pdns/zone-kinds";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { getAppSettings } from "@/lib/settings/app-settings";
import { loadRRsets, normalizeRRsetForAudit, readComments } from "./_shared";

export interface AutoPtrChange {
  change: AddressChange;
  /** The forward RRset as it was before the write (null when it did not exist). */
  before: { ttl: number; records: readonly AddressRecord[] } | null;
  takeover: boolean;
}

export interface AutoPtrRequest {
  forwardServer: PdnsServer;
  forwardZone: string;
  changes: readonly AutoPtrChange[];
  /** The caller's zone-scoped permission check (global OR grant on that server+zone). */
  canOnZone: (serverId: string, zoneName: string, permission: string) => boolean;
  /** Plan only: read everything, write nothing, audit nothing. */
  dryRun: boolean;
  actor: { type: "user" | "token"; id: string };
  request: { ip: string | null; userAgent: string | null; requestId: string | null };
  /**
   * Where the `record.ptr-sync` summary rows attach. "forward" (the editor /
   * API save): one row per forward change, on the forward RRset, so the
   * zone's history explains what its save did elsewhere. "reverse" (the
   * Reverse DNS page, which has no forward change of its own): one row per
   * written PTR, on the reverse RRset.
   */
  summaryMode?: "forward" | "reverse";
}

/** Injection seam for the unit tests; production uses the real modules. */
export interface AutoPtrDeps {
  listBackends: () => Promise<PdnsServer[]>;
  clientFor: (server: PdnsServer) => PdnsClient;
  cachedZones: (serverId: string) => ReadonlyMap<string, { name: string; kind: string }> | null;
  audit: typeof appendAudit;
  afterWrite: (zone: string, serverSlug: string) => void;
}

const defaultDeps: AutoPtrDeps = {
  listBackends: listAllActiveBackends,
  clientFor: getBackendGateway,
  cachedZones: (id) => readCachedZones(id)?.zones ?? null,
  audit: appendAudit,
  afterWrite: (zone, serverSlug) => {
    publishZoneEvent({
      type: "zone.updated",
      zone,
      serverSlug,
      actor: null,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();
  },
};

interface HostedReverseZone {
  name: string;
  hosts: Array<{ server: PdnsServer; kind: string }>;
}

/**
 * Every reverse zone any active backend hosts, with the backends that have it.
 * The 30 s zone-state cache answers for polled backends; the rest are listed
 * live (one request per backend, only when a PTR-enabled change needs it).
 */
async function discoverReverseZones(deps: AutoPtrDeps): Promise<Map<string, HostedReverseZone>> {
  const out = new Map<string, HostedReverseZone>();
  const servers = await deps.listBackends();
  await Promise.all(
    servers.map(async (server) => {
      let zones: Array<{ name: string; kind: string }>;
      const cached = deps.cachedZones(server.id);
      if (cached) {
        zones = [...cached.values()];
      } else {
        try {
          zones = await deps.clientFor(server).listZones();
        } catch (err) {
          logger.warn(
            { server: server.slug, error: err instanceof Error ? redact(err.message) : "unknown" },
            "auto-ptr.list-zones.failed",
          );
          return;
        }
      }
      for (const z of zones) {
        if (!isReverseZone(z.name)) continue;
        const name = canonicalZone(z.name);
        const entry = out.get(name) ?? { name, hosts: [] };
        entry.hosts.push({ server, kind: z.kind });
        out.set(name, entry);
      }
    }),
  );
  return out;
}

/** The backend a PTR write for `zone` goes to, or null when no copy is writable. */
function chooseHost(
  zone: HostedReverseZone,
  forwardServer: PdnsServer,
): { server: PdnsServer; kind: string } | null {
  const writable = zone.hosts.filter(
    (h) => h.server.writeMode !== "read_only" && !isReadOnlyZoneKind(h.kind),
  );
  if (writable.length === 0) return null;
  return (
    writable.find((h) => h.server.id === forwardServer.id) ??
    writable.find(
      (h) => forwardServer.clusterId !== null && h.server.clusterId === forwardServer.clusterId,
    ) ??
    writable[0]!
  );
}

function outcomeBase(c: AutoPtrChange) {
  return { forward: { name: c.change.name, type: c.change.type, kind: c.change.kind } };
}

/**
 * Plan (and unless `dryRun`, apply) the PTR side of the given A/AAAA changes.
 * Never throws for a PTR problem: every address gets an outcome.
 */
export async function runAutoPtr(
  input: AutoPtrRequest,
  deps: AutoPtrDeps = defaultDeps,
): Promise<AutoPtrOutcome[]> {
  if (input.changes.length === 0) return [];
  const reverseZones = await discoverReverseZones(deps);
  const hostedNames = [...reverseZones.keys()];

  // Which owners each reverse zone must be read for, across every change.
  const ownersByZone = new Map<string, Set<string>>();
  for (const c of input.changes) {
    for (const [owner, zone] of candidatePtrOwners(c.change, c.before, hostedNames)) {
      const set = ownersByZone.get(zone) ?? new Set<string>();
      set.add(owner);
      ownersByZone.set(zone, set);
    }
  }

  // Read the existing PTRs from the backend each zone will be written on.
  const existing = new Map<string, ExistingPtr & { comments: Array<Record<string, unknown>> }>();
  const hostFor = new Map<string, { server: PdnsServer; kind: string }>();
  const unreadable = new Set<string>();
  const unwritable = new Set<string>();
  await Promise.all(
    [...ownersByZone.entries()].map(async ([zone, owners]) => {
      const host = chooseHost(reverseZones.get(zone)!, input.forwardServer);
      if (!host) {
        unwritable.add(zone);
        return;
      }
      hostFor.set(zone, host);
      try {
        const rrsets = await loadRRsets(
          deps.clientFor(host.server),
          zone,
          [...owners].map((name) => ({ name, type: "PTR" })),
        );
        for (const [key, rr] of rrsets) {
          if (!key.endsWith("|PTR")) continue;
          existing.set(rr.name, { ttl: rr.ttl, records: rr.records, comments: readComments(rr) });
        }
      } catch (err) {
        unreadable.add(zone);
        logger.warn(
          {
            server: host.server.slug,
            zone,
            error: err instanceof Error ? redact(err.message) : "unknown",
          },
          "auto-ptr.read.failed",
        );
      }
    }),
  );

  // Plan, then gate each planned write on the caller's permission in the reverse zone.
  const outcomes: AutoPtrOutcome[] = [];
  const writes = new Map<
    string,
    {
      host: { server: PdnsServer; kind: string };
      items: Array<{ outcome: AutoPtrOutcome; patch: RRsetPatch; before: unknown; after: unknown }>;
    }
  >();
  for (const c of input.changes) {
    const plan = planPtrChanges(c.change, c.before, {
      hostedReverseZones: hostedNames,
      existing,
      takeover: c.takeover,
    });
    for (const item of plan.items) {
      const zone = item.reverseZone;
      const host = zone ? hostFor.get(zone) : undefined;
      const base: AutoPtrOutcome = {
        ...outcomeBase(c),
        ip: item.ip,
        owner: item.owner,
        reverseZone: zone,
        server: host?.server.slug ?? null,
        action: item.action,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.currentTargets ? { currentTargets: item.currentTargets } : {}),
      };
      if (zone && unwritable.has(zone)) {
        outcomes.push({
          ...base,
          action: "skip",
          reason: "reverse-zone-not-writable",
          currentTargets: undefined,
        });
        continue;
      }
      if (zone && unreadable.has(zone)) {
        outcomes.push({
          ...base,
          action: "failed",
          reason: "read-failed",
          currentTargets: undefined,
        });
        continue;
      }
      if (!zone || !host) {
        outcomes.push(base);
        continue;
      }
      // Permission in the reverse zone gates everything that would write there,
      // and a conflict is a write the caller could not have made either way.
      // Someone without rights gets a skip and never the current target.
      const needsWrite =
        item.action === "create" ||
        item.action === "update" ||
        item.action === "delete" ||
        item.action === "conflict";
      const allowed =
        item.action === "delete"
          ? input.canOnZone(host.server.id, zone, "record.delete")
          : input.canOnZone(host.server.id, zone, "record.create") ||
            input.canOnZone(host.server.id, zone, "record.update");
      if (!allowed) {
        outcomes.push(
          needsWrite
            ? { ...base, action: "skip", reason: "no-permission", currentTargets: undefined }
            : { ...base, currentTargets: undefined },
        );
        continue;
      }
      if (!needsWrite || item.action === "conflict") {
        outcomes.push(base);
        continue;
      }
      outcomes.push(base);
      if (input.dryRun) continue;
      const current = existing.get(item.owner);
      const before = current
        ? normalizeRRsetForAudit({
            name: item.owner,
            type: "PTR",
            ttl: current.ttl,
            records: current.records,
            comments: current.comments,
          })
        : null;
      let patch: RRsetPatch;
      let after: unknown;
      if (item.action === "delete" || !item.rrset) {
        patch = deleteRRset(item.owner, "PTR");
        after = null;
      } else {
        const comments = current?.comments ?? [];
        patch = replaceRRset({
          name: item.owner,
          type: "PTR",
          ttl: item.rrset.ttl,
          records: item.rrset.records,
          comments,
        });
        after = {
          name: item.owner,
          type: "PTR",
          ttl: item.rrset.ttl,
          records: item.rrset.records,
          comments,
        };
      }
      const bucket = writes.get(zone) ?? { host, items: [] };
      bucket.items.push({ outcome: base, patch, before, after });
      writes.set(zone, bucket);
    }
  }
  if (input.dryRun) return outcomes;

  // One PATCH per reverse zone. A failure marks that zone's outcomes, nothing else.
  for (const [zone, { host, items }] of writes) {
    const client = deps.clientFor(host.server);
    try {
      await client.patchZone(zone, zonePatchBody(...items.map((i) => i.patch)));
    } catch (err) {
      const message = err instanceof Error ? redact(err.message) : "unknown error";
      logger.warn({ server: host.server.slug, zone, error: message }, "auto-ptr.write.failed");
      for (const i of items) {
        i.outcome.action = "failed";
        i.outcome.reason = "write-failed";
        i.outcome.message = message;
      }
      continue;
    }
    deps.afterWrite(zone, host.server.slug);
    const audits = items.map((i) =>
      deps.audit({
        actor: input.actor,
        action:
          i.outcome.action === "delete"
            ? "record.delete"
            : i.before === null
              ? "record.create"
              : "record.update",
        resource: { type: "rrset", id: `${host.server.slug}:${zone}:${i.outcome.owner}|PTR` },
        before: i.before,
        after: i.after,
        request: input.request,
      }),
    );
    if (isTransferredKind(host.kind)) {
      audits.push(
        notifyZoneBestEffort(client, zone).then((r) =>
          deps.audit({
            actor: input.actor,
            action: "zone.notify",
            resource: { type: "zone", id: `${host.server.slug}:${zone}` },
            after: { kind: host.kind, success: r.ok, error: r.error, autoPtr: true },
            request: input.request,
          }),
        ),
      );
    }
    for (const r of await Promise.allSettled(audits)) {
      if (r.status === "rejected") {
        logger.warn(
          { zone, error: r.reason instanceof Error ? r.reason.message : "unknown" },
          "auto-ptr.audit.failed",
        );
      }
    }
  }

  if (input.summaryMode === "reverse") {
    const summaries = outcomes
      .filter((o) => o.action !== "unchanged" && o.reverseZone)
      .map((o) => {
        const reverseSlug = o.server ?? input.forwardServer.slug;
        return deps.audit({
          actor: input.actor,
          action: "record.ptr-sync",
          resource: { type: "rrset", id: `${reverseSlug}:${o.reverseZone}:${o.owner}|PTR` },
          after: { outcomes: [o], lines: [describePtrOutcome(o)], source: "reconciler" },
          request: input.request,
        });
      });
    for (const r of await Promise.allSettled(summaries)) {
      if (r.status === "rejected") {
        logger.warn(
          { error: r.reason instanceof Error ? r.reason.message : "unknown" },
          "auto-ptr.summary-audit.failed",
        );
      }
    }
    return outcomes;
  }

  // One summary row per forward change that had PTR work, tied to it by resource id.
  const summaries = input.changes
    .map((c) => {
      const mine = outcomes.filter(
        (o) =>
          o.forward.name === c.change.name &&
          o.forward.type === c.change.type &&
          o.forward.kind === c.change.kind,
      );
      if (mine.length === 0 || mine.every((o) => o.action === "unchanged")) return null;
      return deps.audit({
        actor: input.actor,
        action: "record.ptr-sync",
        resource: {
          type: "rrset",
          id: `${input.forwardServer.slug}:${input.forwardZone}:${c.change.name}|${c.change.type}`,
        },
        after: { outcomes: mine, lines: mine.map(describePtrOutcome) },
        request: input.request,
      });
    })
    .filter((p): p is Promise<void> => p !== null);
  for (const r of await Promise.allSettled(summaries)) {
    if (r.status === "rejected") {
      logger.warn(
        {
          zone: input.forwardZone,
          error: r.reason instanceof Error ? r.reason.message : "unknown",
        },
        "auto-ptr.summary-audit.failed",
      );
    }
  }
  return outcomes;
}

/**
 * The zone's effective auto-PTR default: its `X-AUTHADMIN-AUTO-PTR` metadata,
 * else the global `auto_ptr` setting. A metadata read failure falls back to the
 * global value rather than failing the save that asked.
 */
export async function resolveZoneAutoPtr(
  client: PdnsClient,
  zoneName: string,
): Promise<ResolvedAutoPtr> {
  let zone: boolean | null = null;
  try {
    zone = zoneAutoPtrFromMetadata(await client.listZoneMetadata(zoneName));
  } catch (err) {
    logger.warn(
      { zone: zoneName, error: err instanceof Error ? redact(err.message) : "unknown" },
      "auto-ptr.metadata.read-failed",
    );
  }
  const global = (await getAppSettings()).autoPtr;
  return resolveAutoPtr({ zone, global });
}
