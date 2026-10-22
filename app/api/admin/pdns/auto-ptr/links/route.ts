/**
 * app/api/admin/pdns/auto-ptr/links/route.ts
 *
 * GET ?zone=<name>&serverSlug=<slug> - the cross-references the record table
 * decorates its rows with: for a forward zone, what the PTR of each A/AAAA
 * address says; for a reverse zone, which A/AAAA records point at each PTR's
 * address. Fetched by the table after it renders, so the zone page never waits
 * on a fleet read; answered from the shared scan (`_scan.ts`), so it is cheap
 * after the first call.
 *
 * Permissions: `zone.read` + `record.read` on the requested zone, and every
 * cross-referenced record is filtered by `zone.read` on ITS zone, so the chips
 * never reveal a zone the caller cannot open. Hrefs point at zone pages, which
 * enforce the same check again.
 */

import { requireUser } from "@/lib/auth/require-user";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import {
  canonicalZone,
  findReverseZone,
  ipFromReverseOwner,
  sameAddress,
} from "@/lib/dns/reverse-name";
import { zoneKind } from "@/lib/dns/zone-kind";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { getFleetScan } from "../_scan";
import { requireFeature } from "@/lib/http/require-feature";

export interface ForwardLink {
  zone: string;
  server: string;
  name: string;
  type: "A" | "AAAA";
  href: string;
}

export interface AddressLink {
  owner: string;
  reverseZone: string | null;
  reverseServer: string | null;
  href: string | null;
  /** Current PTR targets; empty when there is no PTR. Absent when the caller may not read the reverse zone. */
  targets?: string[];
  status: "ok" | "missing" | "mismatch" | "unhosted" | "unreadable";
}

export interface OwnerLink {
  ip: string;
  targets: string[];
  forward: ForwardLink[];
  status: "ok" | "stale" | "orphan";
}

const zoneHref = (zone: string, server: string): string =>
  `/zones/${encodeURIComponent(zone)}?server=${encodeURIComponent(server)}`;

export async function GET(request: Request): Promise<Response> {
  try {
    requireFeature("reverseDns");
    const auth = await requireUser();
    const url = new URL(request.url);
    const zoneParam = url.searchParams.get("zone") ?? "";
    if (!/^[A-Za-z0-9._\-/]{1,255}$/.test(zoneParam)) throw new ValidationError("Invalid zone.");
    const zone = canonicalZone(zoneParam);
    const slug = url.searchParams.get("serverSlug");
    const server = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
    if (server?.disabledAt !== null)
      throw new ValidationError("Unknown or disabled PowerDNS backend.");

    const scan = await getFleetScan();
    const bySlug = new Map(scan.servers.map((s) => [s.slug, s]));
    const can = (permission: string, serverId: string, zoneName: string): boolean =>
      canActOnZone(auth, { serverId, zoneName, permission });
    const canReadBySlug = (serverSlug: string, zoneName: string): boolean => {
      const s = bySlug.get(serverSlug);
      return s !== undefined && can("zone.read", s.id, zoneName);
    };
    if (!can("zone.read", server.id, zone) || !can("record.read", server.id, zone)) {
      throw new ForbiddenError("Missing zone.read / record.read for this zone.");
    }

    // The scan read one peer per cluster, so "this zone on this backend" means
    // the backend itself or any peer of its cluster.
    const equivalent = new Set(
      scan.servers
        .filter(
          (s) =>
            s.id === server.id || (server.clusterId !== null && s.clusterId === server.clusterId),
        )
        .map((s) => s.slug),
    );
    // Same horizon only: a public zone's address is matched against public
    // reverse zones, an internal zone's against internal ones (ADR-0022).
    const hostedIn = (horizon: string): string[] => [
      ...new Set(scan.hostedReverseZones.filter((h) => h.horizon === horizon).map((h) => h.name)),
    ];
    const hostOf = (name: string, horizon: string) =>
      scan.hostedReverseZones.find((h) => h.name === name && h.horizon === horizon && h.writable) ??
      scan.hostedReverseZones.find((h) => h.name === name && h.horizon === horizon) ??
      null;

    if (zoneKind(zone) === "forward") {
      const mine = scan.forward.filter((r) => r.zone === zone && equivalent.has(r.server));
      const byAddress: Record<string, AddressLink> = {};
      for (const rec of mine) {
        if (byAddress[rec.content]) continue;
        const match = findReverseZone(rec.content, hostedIn(rec.horizon));
        if (!match) {
          byAddress[rec.content] = {
            owner: "",
            reverseZone: null,
            reverseServer: null,
            href: null,
            status: "unhosted",
          };
          continue;
        }
        const host = hostOf(match.zone, rec.horizon);
        if (!host || !canReadBySlug(host.server, match.zone)) {
          byAddress[rec.content] = {
            owner: match.owner,
            reverseZone: match.zone,
            reverseServer: null,
            href: null,
            status: "unreadable",
          };
          continue;
        }
        const current = scan.reverse.find(
          (p) => p.zone === match.zone && p.server === host.server && p.owner === match.owner,
        );
        const targets = current?.targets ?? [];
        const names = new Set(
          mine.filter((r) => sameAddress(r.content, rec.content)).map((r) => r.name),
        );
        const status =
          targets.length === 0
            ? "missing"
            : targets.some((t) => names.has(t.toLowerCase()))
              ? "ok"
              : "mismatch";
        byAddress[rec.content] = {
          owner: match.owner,
          reverseZone: match.zone,
          reverseServer: host.server,
          href: zoneHref(match.zone, host.server),
          targets,
          status,
        };
      }
      return Response.json({ kind: "forward", zone, byAddress });
    }

    const mine = scan.reverse.filter((p) => p.zone === zone && equivalent.has(p.server));
    const byOwner: Record<string, OwnerLink> = {};
    for (const p of mine) {
      const ip = ipFromReverseOwner(p.owner);
      if (!ip) continue;
      const forward: ForwardLink[] = [];
      for (const r of scan.forward) {
        if (
          r.horizon !== p.horizon ||
          !sameAddress(r.content, ip) ||
          !canReadBySlug(r.server, r.zone)
        )
          continue;
        if (
          forward.some(
            (f) =>
              f.name === r.name && f.zone === r.zone && f.server === r.server && f.type === r.type,
          )
        )
          continue;
        forward.push({
          zone: r.zone,
          server: r.server,
          name: r.name,
          type: r.type,
          href: zoneHref(r.zone, r.server),
        });
      }
      forward.sort((a, b) => a.name.localeCompare(b.name));
      const targets = p.targets.map((t) => t.toLowerCase());
      const status =
        forward.length === 0
          ? "orphan"
          : forward.some((f) => targets.includes(f.name))
            ? "ok"
            : "stale";
      byOwner[p.owner] = { ip, targets: p.targets, forward, status };
    }
    return Response.json({ kind: "reverse", zone, byOwner });
  } catch (err) {
    return errorResponse(err, "auto-ptr.links.error");
  }
}
