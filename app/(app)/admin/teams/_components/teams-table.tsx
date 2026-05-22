"use client";

/**
 * app/(app)/admin/teams/_components/teams-table.tsx
 *
 * Client wrapper around the shared `<DataTable>` for the admin
 * teams list. Sortable columns + search. Empty state stays on the
 * page so the "no teams yet" copy doesn't compete with the DataTable's
 * own empty-results message (which is "no matches", not "no data").
 */

import Link from "next/link";
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { freshnessOf } from "@/lib/freshness";

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  /** ISO timestamp of latest admin edit on this team row. */
  lastAdminEditIso: string | null;
}

export function TeamsTable({
  rows,
  showLastAdminEdit,
}: {
  rows: TeamRow[];
  /** Omit column entirely when false — matches T-87/T-88/T-89 gating. */
  showLastAdminEdit: boolean;
}) {
  const columns = useMemo<Array<ColumnDef<TeamRow, unknown>>>(() => {
    const cols: Array<ColumnDef<TeamRow, unknown>> = [
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => <span className="font-medium">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "slug",
        header: "Slug",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "memberCount",
        header: "Members",
        cell: (ctx) => <span className="text-xs">{ctx.getValue<number>()}</span>,
      },
    ];

    if (showLastAdminEdit) {
      cols.push({
        accessorKey: "lastAdminEditIso",
        header: "Last admin edit",
        sortUndefined: "last",
        cell: (ctx) => {
          const iso = ctx.getValue<string | null>();
          if (!iso) return <span className="text-xs text-[color:var(--color-fg-muted)]">—</span>;
          return (
            <span className="text-xs text-[color:var(--color-fg-muted)]" title={iso}>
              {freshnessOf(iso).label}
            </span>
          );
        },
      });
    }

    cols.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: (ctx) => (
        <Link
          href={`/admin/teams/${ctx.row.original.id}`}
          className="text-[color:var(--color-accent)] hover:underline"
        >
          Manage
        </Link>
      ),
    });

    return cols;
  }, [showLastAdminEdit]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search teams by name or slug…"
      initialSort={[{ id: "name", desc: false }]}
      sortParam="sort"
      pageSizeParam="pageSize"
    />
  );
}
