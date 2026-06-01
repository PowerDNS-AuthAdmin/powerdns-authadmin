/**
 * app/(app)/admin/requests/page.tsx
 *
 * Raw HTTP traffic our server sent to PowerDNS, regardless of whether
 * the operation produced an audit row. Reads (list zones, list rrsets,
 * version probes, …) show up here too - useful for end-to-end traffic
 * inspection that the audit-log feed can't surface on its own.
 *
 * Permission: `audit.read` - same as the per-operation HTTP log
 * embedded in the audit-log viewer.
 *
 * Filtering / pagination / sorting all happen in the client component
 * `<PdnsRequestsTable>` - the server just fetches a windowed slice of
 * the most recent rows (filtered if URL params are set), and the
 * client handles the rest without full page reloads. Live updates
 * piggyback on the app-wide RealtimeProvider stream.
 */

import type { Metadata } from "next";
import { z } from "zod";
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { requireUserForPage } from "@/lib/auth/require-user";
import { db } from "@/lib/db";
import { pdnsRequests } from "@/lib/db/schema";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { LiveFeedSubscriber } from "@/components/ui/live-feed-subscriber";
import { PdnsRequestsTable, type PdnsRequestRowClient } from "./_components/pdns-requests-table";

export const metadata: Metadata = { title: "PowerDNS requests" };
export const dynamic = "force-dynamic";

// Server-side hard cap on the window we ship to the client. Client-
// side pagination walks within this slice. 500 rows ≈ 200 KB JSON -
// safe to inline. If the filtered set is bigger, we signal with
// `windowCapped` so the operator narrows their filter.
const WINDOW_SIZE = 500;

const querySchema = z.object({
  serverSlug: z.string().max(64).optional(),
  op: z.string().max(64).optional(),
  status: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
  requestId: z.string().max(64).optional(),
  // ISO datetime-local strings in local time, converted to UTC Date
  // server-side. Empty string treated as unset.
  from: z.string().optional(),
  to: z.string().optional(),
});

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PdnsRequestsPage({ searchParams }: PageProps) {
  await requireUserForPage({ can: "audit.read" });

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v !== "") flat[k] = v;
  }
  const parsed = querySchema.safeParse(flat);
  const filters = parsed.success ? parsed.data : {};

  const conditions: SQL[] = [];
  if (filters.serverSlug) conditions.push(eq(pdnsRequests.serverSlug, filters.serverSlug));
  if (filters.op) conditions.push(eq(pdnsRequests.op, filters.op));
  if (filters.requestId) conditions.push(eq(pdnsRequests.requestId, filters.requestId));
  if (filters.status) conditions.push(eq(pdnsRequests.responseStatus, Number(filters.status)));
  const fromDate = filters.from ? parseLocalDatetime(filters.from) : null;
  const toDate = filters.to ? parseLocalDatetime(filters.to) : null;
  if (fromDate) conditions.push(gte(pdnsRequests.ts, fromDate));
  if (toDate) conditions.push(lte(pdnsRequests.ts, toDate));

  const where = conditions.length === 0 ? undefined : and(...conditions);

  // Fetch WINDOW_SIZE + 1 to detect whether we capped.
  const rows = await db
    .select()
    .from(pdnsRequests)
    .where(where)
    .orderBy(desc(pdnsRequests.ts))
    .limit(WINDOW_SIZE + 1);

  const windowCapped = rows.length > WINDOW_SIZE;
  const shown = rows.slice(0, WINDOW_SIZE);

  const servers = await listAllPdnsServers();
  const serverById = new Map(servers.map((s) => [s.id, s]));
  const serverBySlug = new Map(servers.map((s) => [s.slug, s]));

  const recentForFilters = await db
    .select({ op: pdnsRequests.op, serverSlug: pdnsRequests.serverSlug })
    .from(pdnsRequests)
    .orderBy(desc(pdnsRequests.ts))
    .limit(2000);
  const opChoices = Array.from(new Set(recentForFilters.map((r) => r.op))).sort();
  const slugChoices = Array.from(
    new Set(recentForFilters.map((r) => r.serverSlug).filter((s): s is string => !!s)),
  ).sort();

  const clientRows: PdnsRequestRowClient[] = shown.map((row) => {
    const server =
      (row.serverId ? serverById.get(row.serverId) : null) ??
      (row.serverSlug ? serverBySlug.get(row.serverSlug) : null) ??
      null;
    return {
      id: String(row.id),
      ts: row.ts.toISOString(),
      serverSlug: row.serverSlug ?? "",
      serverName: server?.name ?? null,
      serverDbId: server?.id ?? null,
      op: row.op,
      method: row.method,
      url: row.url,
      requestHeaders: row.requestHeaders!,
      requestBody: row.requestBody,
      responseStatus: row.responseStatus,
      error: row.error,
      requestId: row.requestId,
    };
  });

  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">PowerDNS requests</h1>
          <LiveFeedSubscriber eventTypes={["pdns.request.appended"]} />
        </div>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Every HTTP call this server issued to a PowerDNS backend, including reads (
          <code className="font-mono">zones.list</code>,{" "}
          <code className="font-mono">zones.get</code>) that don&apos;t write audit rows. Sensitive
          headers are redacted. Timestamps shown in your local time.
        </p>
      </header>

      <PdnsRequestsTable
        rows={clientRows}
        opChoices={opChoices}
        slugChoices={slugChoices}
        windowCapped={windowCapped}
        initial={{
          serverSlug: filters.serverSlug ?? "",
          op: filters.op ?? "",
          status: filters.status ?? "",
          requestId: filters.requestId ?? "",
          fromIso: filters.from ?? "",
          toIso: filters.to ?? "",
        }}
      />
    </div>
  );
}

/**
 * Parse a `datetime-local` string ("2026-05-18T13:45") as a Date in
 * the SERVER's local zone. The form input is in the BROWSER's local
 * zone, so this conversion is one source of edge-case skew -
 * acceptable for an admin tool where the operator usually has the
 * server's zone configured to UTC.
 *
 * If the input is malformed, return null and let the caller skip the
 * filter rather than crash.
 */
function parseLocalDatetime(input: string): Date | null {
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
