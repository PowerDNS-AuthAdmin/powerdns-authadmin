/**
 * app/(app)/admin/changes/page.tsx
 *
 * The Change log: every change anyone made - records, zones, DNSSEC, users and
 * access, configuration - in one feed, newest first. It is the audit log
 * filtered to the change vocabulary (lib/audit/change-actions.ts), drawn with
 * the zone page's own Change log component plus a Zone column, so the two
 * read the same. `?zone=&server=` narrows it to one zone across all of that
 * zone's backends, which is where a zone page's "Show all changes" lands.
 *
 * Permission: global `audit.read`, the same as the Audit log and Request log
 * beside it and the zone page's Change log tab. Every row here is already
 * visible to those users in the Audit log; this page only filters it.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { requireUserForPage } from "@/lib/auth/require-user";
import { redactSnapshot } from "@/lib/audit/log";
import {
  CHANGE_ACTIONS,
  CHANGE_CATEGORY_LABEL,
  changeCategoryOf,
  zoneOfResource,
} from "@/lib/audit/change-actions";
import { changeLogEntries } from "@/lib/db/repositories/audit-log";
import { listAllServersForCluster } from "@/lib/db/repositories/pdns-clusters";
import { findPdnsServerBySlug, listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { normalizeZoneId } from "@/lib/pdns/client";
import {
  ZoneChangeLog,
  type ZoneAuditEntryClient,
} from "../../zones/[zoneId]/_components/zone-change-log";

export const metadata: Metadata = { title: "Change log" };

/** Newest rows loaded; the feed's own filters and paging work within them. */
const ROW_LIMIT = 1000;

interface PageProps {
  searchParams: Promise<{ zone?: string; server?: string }>;
}

export default async function ChangeLogPage({ searchParams }: PageProps) {
  await requireUserForPage({ can: "audit.read" });
  const params = await searchParams;

  // Narrow to one zone. A cluster's writes rotate through its peers, so its
  // history is spread over every member's slug (the zone page scopes the same way).
  let zoneScope: { serverSlugs: string[]; name: string } | null = null;
  let scopeServerName: string | null = null;
  const rawZone = typeof params.zone === "string" ? params.zone.trim() : "";
  if (rawZone && rawZone.length <= 255) {
    const name = normalizeZoneId(rawZone);
    const server =
      typeof params.server === "string" && params.server
        ? await findPdnsServerBySlug(params.server)
        : null;
    if (server) {
      scopeServerName = server.name;
      const slugs = server.clusterId
        ? (await listAllServersForCluster(server.clusterId)).map((s) => s.slug)
        : [server.slug];
      zoneScope = { serverSlugs: slugs, name };
    } else {
      // No (or unknown) backend: match the zone on every backend.
      const all = await listAllPdnsServers();
      zoneScope = { serverSlugs: all.map((s) => s.slug), name };
    }
  }

  const [rows, servers] = await Promise.all([
    changeLogEntries(CHANGE_ACTIONS, { zone: zoneScope ?? undefined, limit: ROW_LIMIT }),
    listAllPdnsServers(),
  ]);
  const serverNames = new Map(servers.map((s) => [s.slug, s.name]));

  const entries: ZoneAuditEntryClient[] = rows.map((e) => {
    const where = zoneOfResource(e.resourceType, e.resourceId);
    return {
      id: e.id,
      ts: e.ts.toISOString(),
      actorType: e.actorType,
      actorEmail: e.actorEmail,
      actorName: e.actorName,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      // Snapshots are redacted when written; redact again on the way out, as
      // the zone page does, so nothing secret-shaped reaches the browser.
      before: e.before ? redactSnapshot(e.before) : null,
      after: e.after ? redactSnapshot(e.after) : null,
      requestId: e.requestId,
      zone: where?.zone ?? null,
      serverSlug: where?.serverSlug ?? null,
      serverName: where ? (serverNames.get(where.serverSlug) ?? where.serverSlug) : null,
      category: changeCategoryOf(e.action),
    };
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <History aria-hidden className="h-6 w-6 text-[color:var(--color-fg-muted)]" />
          Change log
        </h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          What people changed, across every zone and the app itself: records, zones, DNSSEC, users
          and access, and configuration. Sign-ins, reads and other events stay in the{" "}
          <Link href="/admin/audit" className="text-[color:var(--color-accent)] hover:underline">
            Audit log
          </Link>
          . Showing the newest {ROW_LIMIT.toLocaleString("en")} changes.
        </p>
      </header>

      {zoneScope ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm">
          <span className="text-[color:var(--color-fg-muted)]">Zone</span>
          <code className="font-mono">{zoneScope.name}</code>
          {scopeServerName ? (
            <span className="text-[color:var(--color-fg-muted)]">on {scopeServerName}</span>
          ) : null}
          <Link
            href="/admin/changes"
            className="ml-auto text-xs text-[color:var(--color-accent)] hover:underline"
          >
            Show all changes
          </Link>
        </div>
      ) : null}

      <ZoneChangeLog
        mode="global"
        entries={entries}
        zoneName={zoneScope?.name ?? ""}
        categoryLabels={CHANGE_CATEGORY_LABEL}
      />
    </div>
  );
}
