"use client";

/**
 * app/(app)/admin/roles/_components/roles-table.tsx
 *
 * Client wrapper around the shared `<DataTable>` for the admin
 * roles list. Sortable columns + search.
 */

import Link from "next/link";
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { freshnessOf } from "@/lib/freshness";

export interface RoleRow {
  id: string;
  name: string;
  slug: string;
  kind: "System" | "Custom";
  permissionCount: number;
  requiresMfa: boolean;
  /** ISO timestamp of latest admin edit on this role. */
  lastAdminEditIso: string | null;
}

export function RolesTable({
  rows,
  showLastAdminEdit,
}: {
  rows: RoleRow[];
  /** Omit column entirely when false — matches T-87/T-88/T-89 gating. */
  showLastAdminEdit: boolean;
}) {
  const columns = useMemo<Array<ColumnDef<RoleRow, unknown>>>(() => {
    const cols: Array<ColumnDef<RoleRow, unknown>> = [
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
        accessorKey: "kind",
        header: "Kind",
        cell: (ctx) => <span className="text-xs">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "permissionCount",
        header: "Permissions",
        cell: (ctx) => <span className="text-xs">{ctx.getValue<number>()}</span>,
      },
      {
        // Surfaces the per-role MFA flag at-a-glance. Was
        // previously only visible by clicking into each role.
        accessorKey: "requiresMfa",
        header: "MFA required",
        cell: (ctx) =>
          ctx.getValue<boolean>() ? (
            <span className="rounded bg-[color:var(--color-warn)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] text-[color:var(--color-warn)]">
              required
            </span>
          ) : (
            <span className="text-xs text-[color:var(--color-fg-muted)]">—</span>
          ),
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
          href={`/admin/roles/${ctx.row.original.id}`}
          className="text-[color:var(--color-accent)] hover:underline"
        >
          View
        </Link>
      ),
    });

    return cols;
  }, [showLastAdminEdit]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search roles by name or slug…"
      initialSort={[{ id: "name", desc: false }]}
      sortParam="sort"
      pageSizeParam="pageSize"
      rowHref={(r) => `/admin/roles/${r.id}`}
    />
  );
}
