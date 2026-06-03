"use client";

/**
 * Read-only TSIG keys table for operators with `tsig.read` but not
 * `tsig.manage`. Same column shape as the writable variant in
 * <TsigActions/>, just no per-row actions - funnels both views onto the
 * shared <DataTable> so the mobile-card layout, sort, and spacing match.
 */

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";

interface Row {
  id: string;
  name: string;
  algorithm: string;
  zoneCount: number;
  zones: string[];
}

export function TsigKeysReadOnly({ serverSlug, rows }: { serverSlug: string; rows: Row[] }) {
  const columns = useMemo<Array<ColumnDef<Row, unknown>>>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => (
          <span className="font-mono text-xs break-all">{ctx.getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "algorithm",
        header: "Algorithm",
        cell: (ctx) => (
          <span className="rounded bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-xs">
            {ctx.getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "zoneCount",
        header: "Domains",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <div className="max-w-sm space-y-1">
              <span
                className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                  row.zoneCount > 0
                    ? "bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]"
                    : "bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg-muted)]"
                }`}
              >
                {row.zoneCount === 0
                  ? "Not applied"
                  : `${row.zoneCount} domain${row.zoneCount === 1 ? "" : "s"}`}
              </span>
              {row.zones.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {row.zones.slice(0, 3).map((zone) => (
                    <span
                      key={zone}
                      title={zone}
                      className="max-w-44 truncate rounded bg-[color:var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-[0.625rem] text-[color:var(--color-fg-muted)]"
                    >
                      {zone}
                    </span>
                  ))}
                  {row.zones.length > 3 ? (
                    <span className="rounded bg-[color:var(--color-bg-subtle)] px-1.5 py-0.5 text-[0.625rem] text-[color:var(--color-fg-muted)]">
                      +{row.zones.length - 3}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "id",
        header: "id",
        cell: (ctx) => (
          <span className="font-mono text-[0.625rem] text-[color:var(--color-fg-muted)]">
            {ctx.getValue<string>()}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={Math.max(rows.length, 10)}
      hidePagination
      hideSearch
      stateKey={`tsig-ro:${serverSlug}`}
      emptyMessage="No keys match."
      noDataMessage={`No TSIG keys configured on ${serverSlug}. AXFR and NOTIFY between this backend and its peers happens without shared-secret authentication.`}
    />
  );
}
