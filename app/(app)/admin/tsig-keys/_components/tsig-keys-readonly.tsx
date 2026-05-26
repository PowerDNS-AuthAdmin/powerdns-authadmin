"use client";

/**
 * Read-only TSIG keys table for operators with `tsig.read` but not
 * `tsig.manage`. Same column shape as the writable variant in
 * <TsigActions/>, just no per-row actions — funnels both views onto the
 * shared <DataTable> so the mobile-card layout, sort, and spacing match.
 */

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";

interface Row {
  id: string;
  name: string;
  algorithm: string;
}

export function TsigKeysReadOnly({ serverSlug, rows }: { serverSlug: string; rows: Row[] }) {
  const columns = useMemo<Array<ColumnDef<Row, unknown>>>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
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
