"use client";

/**
 * app/(app)/admin/audit/_components/audit-table.tsx
 *
 * Client wrapper around the shared <DataTable> for the audit log. The page
 * pre-resolves everything that needs server-side data (user emails, resource
 * hrefs, per-row PDNS HTTP entries, before/after diff lines) and passes a
 * plain row shape - this component does no fetching.
 *
 * Pagination is intentionally hidden: the audit log can be huge, so the page
 * keeps its own server-side `?offset=` prev/next nav (one limit-wide window
 * per HTTP request). DataTable's only job here is the consistent table chrome
 * (mobile cards, sortable headers, same CSS as every other list in the app).
 */
import { useMemo } from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { LocalTime } from "@/components/ui/local-time";
import { Disclosure } from "@/components/ui/disclosure";
import { BareDiff } from "@/app/(app)/zones/[zoneId]/_components/bare-diff";
import {
  PdnsHttpLog,
  type PdnsHttpLogEntry,
} from "@/app/(app)/zones/[zoneId]/_components/pdns-http-log";

export interface AuditRowClient {
  id: string;
  ts: string;
  actorType: string;
  actorEmail: string | null;
  actorId: string | null;
  actorHref: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceDisplay: string | null;
  resourceHref: string | null;
  beforeLines: string[];
  afterLines: string[];
  httpEntries: PdnsHttpLogEntry[];
  ip: string | null;
  requestId: string | null;
}

export function AuditTable({ rows }: { rows: AuditRowClient[] }) {
  const columns = useMemo<Array<ColumnDef<AuditRowClient, unknown>>>(
    () => [
      {
        accessorKey: "ts",
        header: "When",
        cell: (ctx) => (
          <LocalTime
            ts={ctx.getValue<string>()}
            className="font-mono text-[0.6875rem] whitespace-nowrap text-[color:var(--color-fg-muted)]"
          />
        ),
        meta: { className: "w-44" },
      },
      {
        id: "actor",
        accessorFn: (row) => row.actorEmail ?? row.actorId ?? row.actorType,
        header: "Actor",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <div>
              {row.actorEmail ? (
                row.actorHref ? (
                  <Link
                    href={row.actorHref}
                    className="block truncate text-[color:var(--color-accent)] hover:underline"
                    title={row.actorEmail}
                  >
                    {row.actorEmail}
                  </Link>
                ) : (
                  <div className="truncate" title={row.actorEmail}>
                    {row.actorEmail}
                  </div>
                )
              ) : (
                <div>{row.actorType}</div>
              )}
              <div className="text-xs text-[color:var(--color-fg-muted)]">
                {row.actorType}
                {row.actorId ? (
                  <span className="ml-1 font-mono text-[0.625rem]">{row.actorId}</span>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "action",
        header: "Action",
        cell: (ctx) => <span className="font-mono">{ctx.getValue<string>()}</span>,
      },
      {
        id: "resource",
        accessorFn: (row) => row.resourceDisplay ?? row.resourceId ?? row.resourceType,
        header: "Resource",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <div>
              {row.resourceId ? (
                row.resourceHref ? (
                  <Link
                    href={row.resourceHref}
                    className="block truncate text-[color:var(--color-accent)] hover:underline"
                    title={row.resourceId}
                  >
                    {row.resourceDisplay ?? row.resourceId}
                  </Link>
                ) : (
                  <div
                    className="truncate font-mono text-[color:var(--color-fg-muted)]"
                    title={row.resourceId}
                  >
                    {row.resourceDisplay ?? row.resourceId}
                  </div>
                )
              ) : null}
              <div className="text-xs text-[color:var(--color-fg-muted)]">{row.resourceType}</div>
            </div>
          );
        },
      },
      {
        id: "detail",
        header: "Detail",
        enableSorting: false,
        cell: (ctx) => {
          const row = ctx.row.original;
          const hasBeforeAfter = row.beforeLines.length > 0 || row.afterLines.length > 0;
          return (
            <div className="space-y-1 text-xs">
              {hasBeforeAfter ? (
                <Disclosure
                  label="BEFORE / AFTER"
                  className="space-y-1"
                  summaryClassName="uppercase tracking-wide"
                  bodyClassName="mt-1"
                >
                  <BareDiff removed={row.beforeLines} added={row.afterLines} layout="stacked" />
                </Disclosure>
              ) : null}
              {row.httpEntries.length > 0 ? (
                <Disclosure
                  label={`POWERDNS HTTP REQUESTS (${row.httpEntries.length})`}
                  className="space-y-1"
                  summaryClassName="uppercase tracking-wide"
                  bodyClassName="mt-1"
                >
                  <PdnsHttpLog entries={row.httpEntries} collapsible={false} />
                </Disclosure>
              ) : null}
              {row.ip ? (
                <div className="text-[color:var(--color-fg-muted)]">ip: {row.ip}</div>
              ) : null}
              {row.requestId ? (
                <div className="text-[color:var(--color-fg-muted)]">
                  req:{" "}
                  <Link
                    href={`/admin/audit?${new URLSearchParams({ requestId: row.requestId }).toString()}`}
                    className="font-mono text-[color:var(--color-accent)] hover:underline"
                    title="Filter to all rows from this request"
                  >
                    {row.requestId}
                  </Link>
                </div>
              ) : null}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={Math.max(rows.length, 50)}
      hidePagination
      hideSearch
      emptyMessage="No entries match the current filter."
      noDataMessage="No audit rows yet."
    />
  );
}
