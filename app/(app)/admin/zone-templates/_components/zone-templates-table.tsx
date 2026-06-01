"use client";

/**
 * app/(app)/admin/zone-templates/_components/zone-templates-table.tsx
 *
 * Client wrapper around the shared <DataTable> for the Zone-templates list.
 * Clickable rows on desktop, cards on mobile, searchable + sortable. Mirrors
 * the other admin list tables (roles/users/teams/groups).
 */

import Link from "next/link";
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { freshnessOf } from "@/lib/freshness";

export interface ZoneTemplateRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Resolved primary names this template is the default for ([] if none). */
  defaultForNames: string[];
  nameserverCount: number;
  recordCount: number;
  lastAdminEditIso: string | null;
}

export function ZoneTemplatesTable({
  rows,
  showLastAdminEdit,
  canManage,
}: {
  rows: ZoneTemplateRow[];
  showLastAdminEdit: boolean;
  canManage: boolean;
}) {
  const columns = useMemo<Array<ColumnDef<ZoneTemplateRow, unknown>>>(() => {
    const cols: Array<ColumnDef<ZoneTemplateRow, unknown>> = [
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => {
          const r = ctx.row.original;
          return (
            <div>
              <div className="font-medium">{r.name}</div>
              {r.description ? (
                <div className="text-xs text-[color:var(--color-fg-muted)]">{r.description}</div>
              ) : null}
              {r.defaultForNames.length > 0 ? (
                <div className="mt-1 inline-flex items-center gap-1 text-xs text-[color:var(--color-success)]">
                  <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                    <path d="M6.173 11.207 2.93 7.964l1.06-1.06 2.183 2.182 5.834-5.834 1.06 1.06z" />
                  </svg>
                  <span>
                    default for <span className="font-medium">{r.defaultForNames.join(", ")}</span>
                  </span>
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: "slug",
        header: "Slug",
        cell: (ctx) => (
          <code className="rounded bg-[color:var(--color-bg-subtle)] px-1 font-mono text-xs">
            {ctx.getValue<string>()}
          </code>
        ),
      },
      {
        accessorKey: "nameserverCount",
        header: "Nameservers",
        cell: (ctx) => {
          const n = ctx.getValue<number>();
          if (n === 0) return <span className="text-[color:var(--color-fg-muted)]">-</span>;
          return (
            <span className="font-mono text-xs">
              {n} {n === 1 ? "NS" : "NSs"}
            </span>
          );
        },
      },
      {
        accessorKey: "recordCount",
        header: "Records",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<number>()}</span>,
      },
    ];

    if (showLastAdminEdit) {
      cols.push({
        accessorKey: "lastAdminEditIso",
        header: "Last admin edit",
        sortUndefined: "last",
        cell: (ctx) => {
          const iso = ctx.getValue<string | null>();
          if (!iso) return <span className="text-xs text-[color:var(--color-fg-muted)]">-</span>;
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
          href={`/admin/zone-templates/${ctx.row.original.id}`}
          className="text-[color:var(--color-accent)] hover:underline"
        >
          {canManage ? "Edit" : "View"}
        </Link>
      ),
    });

    return cols;
  }, [showLastAdminEdit, canManage]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search templates by name or slug…"
      initialSort={[{ id: "name", desc: false }]}
      sortParam="sort"
      pageSizeParam="pageSize"
      rowHref={(r) => `/admin/zone-templates/${r.id}`}
    />
  );
}
