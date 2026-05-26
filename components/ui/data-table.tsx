"use client";

/**
 * components/ui/data-table.tsx
 *
 * Reusable data table built on TanStack Table v8 — the library  §3
 * picks for every row-based view in the app. Adds the affordances every list
 * in PowerDNS-AuthAdmin needs:
 *
 *   - Click-to-sort on column headers, with direction indicators.
 *   - Global search filter (matches across every accessor by default; per-
 *     column filters land when a list needs them).
 *   - Client-side pagination with a page-size selector.
 *   - "Showing N–M of K" counter beneath the table.
 *   - Zebra-striped rows + hover highlight, all from design tokens so both
 *     light and dark themes track automatically.
 *
 * What's NOT shipped (and the reason): a sticky header. Current
 * markup nests the table inside `overflow-hidden` (for the rounded
 * border) + `overflow-x-auto` (for narrow viewports). Both create
 * scroll containing blocks that catch `position: sticky`, so a naive
 * `sticky top-0` on `<thead>` would stick to the inner div (which
 * has no scroll) instead of the page. Implementing it properly
 * requires either bounding the container with a max-height (adds an
 * inner scrollbar — operator-hostile for short lists) or moving the
 * rounded-corner styling off the wrapper so the table can scroll with
 * the page. Filed for revisit once the largest list (zones, possibly
 * 100s of rows) proves it needs it.
 *
 * What we don't yet need (and so don't ship): server-side pagination
 * (once we federate across multiple backends), virtualization (a
 * future RRset-editor concern at 50k+ rows), column visibility/reorder
 * (admin-table polish for later).
 *
 * Usage:
 *
 *   const columns: ColumnDef<Zone>[] = [
 *     { accessorKey: "name", header: "Name",
 *       cell: (ctx) => <Link href=…>{ctx.getValue<string>()}</Link> },
 *     { accessorKey: "kind", header: "Kind" },
 *   ];
 *   <DataTable columns={columns} data={zones}
 *              searchPlaceholder="Search zones…"
 *              initialSort={[{ id: "name", desc: false }]} />
 */

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { parsePageSizeParam, parseSortParam, serializeSortParam } from "./data-table-url-sync";
import { SelectMenu } from "./select-menu";

// Per-column styling hook. TanStack v8.21 tightened `ColumnMeta` from a loose
// empty interface to one that rejects unknown properties, so the `className`
// we read off `columnDef.meta` must be declared via module augmentation.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    className?: string;
  }
}

export interface DataTableProps<TData> {
  columns: Array<ColumnDef<TData, unknown>>;
  data: TData[];
  /** Initial column sort. Leave empty to start unsorted (insertion order). */
  initialSort?: SortingState;
  /** Placeholder for the global search input. */
  searchPlaceholder?: string;
  /** Initial page size; user can change via the dropdown. */
  pageSize?: number;
  /** Page-size options shown in the selector. */
  pageSizeOptions?: number[];
  /** Render when there are zero rows AFTER filtering. */
  emptyMessage?: string;
  /** Override for the "no rows AT ALL" state — separate from "filter matched nothing". */
  noDataMessage?: string;
  /** Optional className for the root container. */
  className?: string;
  /** When true, hide the search box (useful for small datasets). */
  hideSearch?: boolean;
  /** When true, hide pagination (useful for fixed-size lists). */
  hidePagination?: boolean;
  /**
   * `auto` (default) lets the browser size columns to fit content — the
   * wider-is-better default for most lists. `fixed` switches to
   * `table-layout: fixed` so columns respect the widths declared via each
   * column's `meta.className` (`w-[…]`) and long unbroken content (TXT
   * records, base64 keys) wraps inside its cell instead of stretching
   * the table horizontally. Pair with `break-all` on the relevant cell
   * content for the wrapping to actually take effect.
   */
  layout?: "auto" | "fixed";
  /**
   * Sync the sort state to a URL search-param of this name. When set,
   * the table reads its initial sort from `?<sortParam>=<col>.<dir>`
   * (or `<col1>.<dir1>,<col2>.<dir2>` for multi-column) and writes
   * back on every sort change via `router.replace` (no history
   * entry, no scroll). Last-edit sort survives navigation.
   *
   * When omitted, sort stays local-state and `initialSort` applies.
   */
  sortParam?: string;
  /**
   * Sync the page-size choice to a URL search-param of this name.
   * Read on mount, written on every page-size change. Validated to
   * be a positive integer that appears in `pageSizeOptions` — values
   * outside the allowed set are ignored and the `pageSize` default
   * applies. operator's row-density choice survives
   * navigation.
   *
   * When omitted, page size stays local-state and `pageSize` applies.
   */
  pageSizeParam?: string;
  /**
   * When set, the table mirrors its sort + page-size state to
   * `localStorage` under `pda.table.<stateKey>`. Hydrates on mount.
   * URL params (when present) win over localStorage; localStorage
   * wins over `initialSort` / `pageSize` props. The user-facing
   * effect is "my row-density and sort choice stick across visits."
   *
   * Pick a stable key per table — e.g. "zones", "records:<zone>",
   * "users". Tables with no key persist nothing (default behavior).
   */
  stateKey?: string;
  /**
   * Render an inline detail row directly beneath a given row, spanning all
   * columns. Return `null`/`undefined` to render nothing — the caller owns
   * expansion state (e.g. return the panel only for expanded row ids). Used by
   * the PDNS-requests viewer to expand a request's full HTTP log in place.
   */
  renderRowDetail?: (row: TData) => React.ReactNode;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export function DataTable<TData>({
  columns,
  data,
  initialSort = [],
  searchPlaceholder = "Search…",
  pageSize = 10,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  emptyMessage = "No matches.",
  noDataMessage = "No data.",
  className = "",
  hideSearch = false,
  hidePagination = false,
  sortParam,
  pageSizeParam,
  stateKey,
  layout = "auto",
  renderRowDetail,
}: DataTableProps<TData>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // When sortParam is set, the URL is the source of truth and
  // initialSort is the fallback for "no param present". When unset,
  // initialSort owns the initial value and the table runs local.
  const urlSort = sortParam ? parseSortParam(searchParams.get(sortParam)) : null;
  const [sorting, setSorting] = useState<SortingState>(
    urlSort && urlSort.length > 0 ? urlSort : initialSort,
  );
  const [globalFilter, setGlobalFilter] = useState("");
  // Same pattern as sort for page-size: URL is source of truth when
  // pageSizeParam is set, falling back to the `pageSize` prop when
  // the URL value is missing or invalid. The allowed set is the
  // user-visible options (DEFAULT_PAGE_SIZE_OPTIONS plus pageSize).
  const initialPageSize =
    pageSizeParam !== undefined
      ? (parsePageSizeParam(searchParams.get(pageSizeParam), [pageSize, ...pageSizeOptions]) ??
        pageSize)
      : pageSize;
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  // localStorage hydration. Runs once on mount. Skipped on SSR
  // (typeof window is undefined). URL params, when present, always
  // win — `urlSort` / `pageSizeParam`-derived initial states are
  // already in the state above; we only restore when the URL is
  // silent on that axis.
  useEffect(() => {
    if (!stateKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`pda.table.${stateKey}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { sorting?: SortingState; pageSize?: number };
      if (!urlSort && Array.isArray(parsed.sorting) && parsed.sorting.length > 0) {
        setSorting(parsed.sorting);
      }
      const urlPageSizeKnown =
        pageSizeParam !== undefined &&
        parsePageSizeParam(searchParams.get(pageSizeParam), [pageSize, ...pageSizeOptions]) !==
          null;
      if (
        !urlPageSizeKnown &&
        typeof parsed.pageSize === "number" &&
        [pageSize, ...pageSizeOptions].includes(parsed.pageSize)
      ) {
        setPagination((prev) => ({ ...prev, pageSize: parsed.pageSize! }));
      }
    } catch {
      // Corrupt localStorage → ignore and keep current state. No
      // amount of operator-visible scolding about JSON parse errors
      // is better than just letting them re-pick their preferences.
    }
    // Deliberately mount-only: re-running on every URL change would
    // re-hydrate over fresh user choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey]);

  // Persist on every change to sort or page-size. Both axes go in
  // one row keyed off `stateKey`. pageIndex is intentionally NOT
  // persisted — it changes every Next/Prev click and shouldn't
  // outlive the page visit.
  useEffect(() => {
    if (!stateKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `pda.table.${stateKey}`,
        JSON.stringify({ sorting, pageSize: pagination.pageSize }),
      );
    } catch {
      // Storage quota exceeded / blocked. Lose persistence; don't
      // surface the error — non-essential UX nicety.
    }
  }, [stateKey, sorting, pagination.pageSize]);

  // Generic URL-param writer used for both sort and pageSize.
  // Compares against the current URL value so identical updates
  // don't trigger a `router.replace` feedback loop. Empty serialized
  // value removes the param entirely.
  const writeParamToUrl = useCallback(
    (name: string | undefined, serialized: string) => {
      if (!name) return;
      const current = searchParams.get(name) ?? "";
      if (serialized === current) return;
      const params = new URLSearchParams(searchParams.toString());
      if (serialized === "") params.delete(name);
      else params.set(name, serialized);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, pagination },
    onSortingChange: (updater) => {
      setSorting((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        writeParamToUrl(sortParam, serializeSortParam(next));
        return next;
      });
      // jump to page 1 on every sort change. Without this
      // the operator on page 7 clicks a header and stays on page 7
      // of a now-reordered dataset — confusing, and the rows that
      // sorted to the top are invisible. Same default as the
      // global-filter input above, which also resets page-index on
      // input. Direct setState bypasses onPaginationChange so the
      // pageSize URL param doesn't get spuriously rewritten.
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
    },
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: (updater) => {
      setPagination((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        // Only sync page-size; pageIndex stays ephemeral (it
        // changes on every Next/Prev click and shouldn't pollute
        // the URL). Serialize empty when value matches the prop
        // default so sharing a link doesn't include a redundant
        // pageSize=25 when 25 is also the default.
        const serialized = next.pageSize === pageSize ? "" : String(next.pageSize);
        writeParamToUrl(pageSizeParam, serialized);
        return next;
      });
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const totalCount = data.length;
  const pageSizeOptionsResolved = useMemo(
    () => Array.from(new Set([pageSize, ...pageSizeOptions])).sort((a, b) => a - b),
    [pageSize, pageSizeOptions],
  );

  const showingFrom = rows.length === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const showingTo = pagination.pageIndex * pagination.pageSize + rows.length;

  // Leaf header cells, used to label fields in the mobile card view. A column
  // with no header text (action columns) gets no label — its cell renders
  // full-width at the foot of the card instead.
  const leafHeaders = table.getHeaderGroups().at(-1)?.headers ?? [];
  const headerLabel = (columnId: string): React.ReactNode | null => {
    const h = leafHeaders.find((hdr) => hdr.column.id === columnId);
    const def = h?.column.columnDef.header;
    if (!h || def == null || def === "") return null;
    return flexRender(def, h.getContext());
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {!hideSearch ? (
        <div className="flex items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-[color:var(--color-fg-muted)]"
            />
            <input
              type="search"
              value={globalFilter}
              onChange={(e) => {
                setGlobalFilter(e.target.value);
                table.setPageIndex(0);
              }}
              placeholder={searchPlaceholder}
              className="block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1.5 pr-3 pl-8 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
            />
          </div>
          {globalFilter ? (
            <span className="text-xs text-[color:var(--color-fg-muted)]">
              {filteredCount} match{filteredCount === 1 ? "" : "es"}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Mobile (< md): a card per row. Avoids horizontal scrolling — each
          column becomes a labelled field, the first cell is the card title. */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-[color:var(--color-border)] px-4 py-10 text-center text-sm text-[color:var(--color-fg-muted)]">
            {totalCount === 0 ? noDataMessage : emptyMessage}
          </div>
        ) : (
          rows.map((row) => {
            const cells = row.getVisibleCells();
            const detail = renderRowDetail?.(row.original);
            return (
              <div
                key={row.id}
                className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4"
              >
                {cells.map((cell, i) => {
                  const label = headerLabel(cell.column.id);
                  const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                  // First cell → card title. Labelled cells → label/value row.
                  // Unlabelled cells (actions) → full-width.
                  if (i === 0) {
                    return (
                      <div key={cell.id} className="mb-2 text-base font-medium break-words">
                        {content}
                      </div>
                    );
                  }
                  if (label == null) {
                    return (
                      <div key={cell.id} className="mt-3">
                        {content}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={cell.id}
                      className="flex justify-between gap-3 border-t border-[color:var(--color-border)] py-1.5 text-sm first:border-t-0"
                    >
                      <span className="shrink-0 text-[color:var(--color-fg-muted)]">{label}</span>
                      <span className="min-w-0 text-right break-words">{content}</span>
                    </div>
                  );
                })}
                {detail != null ? <div className="mt-3">{detail}</div> : null}
              </div>
            );
          })
        )}
      </div>

      {/* Desktop (md+): the dense table. overflow-x-auto only kicks in when a
          table genuinely can't fit — the common case stays scroll-free. */}
      <div className="hidden overflow-hidden rounded-lg border border-[color:var(--color-border)] md:block">
        <div className="overflow-x-auto">
          <table className={`w-full text-sm ${layout === "fixed" ? "table-fixed" : ""}`}>
            <thead className="bg-[color:var(--color-bg-muted)] text-left text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sortDir = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        className={[
                          "px-4 py-2.5",
                          canSort
                            ? "cursor-pointer select-none hover:bg-[color:var(--color-bg-muted)]"
                            : "",
                          header.column.columnDef.meta?.className ?? "",
                        ].join(" ")}
                        onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        aria-sort={
                          sortDir === "asc"
                            ? "ascending"
                            : sortDir === "desc"
                              ? "descending"
                              : canSort
                                ? "none"
                                : undefined
                        }
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort ? (
                            sortDir === "asc" ? (
                              <ChevronUp className="h-3 w-3" aria-hidden />
                            ) : sortDir === "desc" ? (
                              <ChevronDown className="h-3 w-3" aria-hidden />
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden />
                            )
                          ) : null}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getAllColumns().length}
                    className="px-4 py-10 text-center text-sm text-[color:var(--color-fg-muted)]"
                  >
                    {totalCount === 0 ? noDataMessage : emptyMessage}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const detail = renderRowDetail?.(row.original);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        // Four visually distinct row states, all token-driven so
                        // both themes track automatically:
                        //   header → bg-muted (the strongest neutral, anchors the top)
                        //   odd    → transparent (page bg)
                        //   even   → bg-subtle stripe
                        //   hover  → faint accent wash, distinct from every neutral
                        //            shade above (and a subtle brand cue).
                        // The hover color is semi-transparent over the page bg, so
                        // it reads identically on odd and even rows. Tailwind emits
                        // the `hover:` variant after `even:`, so hover wins the
                        // cascade on striped rows without needing `!important`.
                        className="border-t border-[color:var(--color-border)] transition-colors even:bg-[color:var(--color-bg-subtle)] hover:bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)]"
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            className={[
                              "px-4 py-3 align-top",
                              cell.column.columnDef.meta?.className ?? "",
                            ].join(" ")}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                      {detail != null ? (
                        <tr className="border-t-0">
                          <td
                            colSpan={row.getVisibleCells().length}
                            className="bg-[color:var(--color-bg-subtle)] px-4 pt-0 pb-3"
                          >
                            {detail}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!hidePagination && totalCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--color-fg-muted)]">
          <span>
            Showing {showingFrom}–{showingTo} of {filteredCount}
            {globalFilter && filteredCount !== totalCount ? ` (filtered from ${totalCount})` : ""}
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              <span>Rows</span>
              <SelectMenu
                value={String(pagination.pageSize)}
                onChange={(v) => table.setPageSize(Number(v))}
                options={pageSizeOptionsResolved.map((size) => ({
                  value: String(size),
                  label: String(size),
                }))}
                ariaLabel="Rows per page"
                className="w-20"
              />
            </label>
            <div className="inline-flex items-center gap-1">
              <PaginationButton
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
                label="First"
                className="hidden sm:inline-block"
              />
              <PaginationButton
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                label="Prev"
              />
              <span className="px-2 whitespace-nowrap tabular-nums">
                {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
              </span>
              <PaginationButton
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                label="Next"
              />
              <PaginationButton
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
                label="Last"
                className="hidden sm:inline-block"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PaginationButton({
  onClick,
  disabled,
  label,
  className = "",
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-40 ${className}`}
    >
      {label}
    </button>
  );
}
