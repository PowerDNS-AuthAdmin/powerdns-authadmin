"use client";

/**
 * Client-side filterable + paginated PDNS-requests viewer.
 *
 * Loads the most recent window of rows from the server (already
 * filtered server-side if there are URL params). All in-window
 * filtering, sorting, and pagination is then client-only via the
 * shared `<DataTable>` — same UX shape as the records table on the
 * zone detail page.
 *
 * Filter changes update URL params via `router.replace({scroll:false})`
 * so the page re-fetches data WITHOUT a full navigation — keeps the
 * app-wide SSE connection (and its "Live" chip) intact instead of
 * flashing through offline / connecting / live on every Apply.
 *
 * Live updates: subscribes to `pdns.request.appended` events on the
 * shared RealtimeProvider. Each event triggers a debounced
 * `router.refresh()` so new rows appear without manual reloads.
 */

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { SelectMenu } from "@/components/ui/select-menu";
import { LocalTime } from "@/components/ui/local-time";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { PdnsHttpLog } from "@/app/(app)/zones/[zoneId]/_components/pdns-http-log";

export interface PdnsRequestRowClient {
  id: string;
  ts: string;
  serverSlug: string;
  serverName: string | null;
  serverDbId: string | null;
  op: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number | null;
  error: string | null;
  requestId: string | null;
}

interface Props {
  /** Already filtered-and-windowed at the server, newest first. */
  rows: PdnsRequestRowClient[];
  /** Available op values for the dropdown — top-N most recent. */
  opChoices: string[];
  /** Available server slugs for the dropdown. */
  slugChoices: string[];
  /** True when the window was capped — operator should narrow filters. */
  windowCapped: boolean;
  initial: {
    serverSlug: string;
    op: string;
    status: string;
    requestId: string;
    fromIso: string;
    toIso: string;
  };
}

export function PdnsRequestsTable(props: Props) {
  const router = useRouter();

  // Local form state — controlled inputs. Apply (or auto-debounce)
  // pushes them to the URL via router.replace, which re-runs the
  // server component WITHOUT a full navigation.
  const [serverSlug, setServerSlug] = useState(props.initial.serverSlug);
  const [op, setOp] = useState(props.initial.op);
  const [status, setStatus] = useState(props.initial.status);
  const [requestId, setRequestId] = useState(props.initial.requestId);
  const [fromIso, setFromIso] = useState(props.initial.fromIso);
  const [toIso, setToIso] = useState(props.initial.toIso);

  const filtersDirty =
    serverSlug !== props.initial.serverSlug ||
    op !== props.initial.op ||
    status !== props.initial.status ||
    requestId !== props.initial.requestId ||
    fromIso !== props.initial.fromIso ||
    toIso !== props.initial.toIso;

  function applyFilters() {
    const params = new URLSearchParams();
    if (serverSlug) params.set("serverSlug", serverSlug);
    if (op) params.set("op", op);
    if (status) params.set("status", status);
    if (requestId) params.set("requestId", requestId);
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    const q = params.toString();
    router.replace(`/admin/pdns-requests${q ? `?${q}` : ""}`, { scroll: false });
  }

  function clearFilters() {
    setServerSlug("");
    setOp("");
    setStatus("");
    setRequestId("");
    setFromIso("");
    setToIso("");
    router.replace("/admin/pdns-requests", { scroll: false });
  }

  // Live updates — refresh server data when new PDNS-request rows
  // get written. Debounced to one refresh per 1.5 s so a burst of
  // requests doesn't refetch on every single one.
  const lastRefreshAt = useRef<number>(0);
  useRealtimeEvent(
    (event) => event.type === "pdns.request.appended",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 1_500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  const columns = useMemo<Array<ColumnDef<PdnsRequestRowClient, unknown>>>(
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
        id: "server",
        accessorFn: (row) => row.serverName ?? row.serverSlug,
        header: "Server",
        cell: (ctx) => {
          const row = ctx.row.original;
          const label = row.serverName ?? row.serverSlug;
          if (row.serverDbId) {
            return (
              <Link
                href={`/admin/servers/${row.serverDbId}`}
                className="text-[color:var(--color-accent)] hover:underline"
              >
                {label}
              </Link>
            );
          }
          return <span>{label}</span>;
        },
        meta: { className: "w-44" },
      },
      {
        accessorKey: "op",
        header: "Op",
        cell: (ctx) => <span className="font-mono">{ctx.getValue<string>()}</span>,
        meta: { className: "w-32" },
      },
      {
        accessorKey: "method",
        header: "Method",
        cell: (ctx) => <span className="font-mono">{ctx.getValue<string>()}</span>,
        meta: { className: "w-20" },
      },
      {
        accessorKey: "url",
        header: "URL",
        cell: (ctx) => (
          <span className="font-mono break-all">{shortenUrl(ctx.getValue<string>())}</span>
        ),
      },
      {
        accessorKey: "responseStatus",
        header: "Status",
        cell: (ctx) => {
          const row = ctx.row.original;
          const isFailure =
            row.error !== null || (row.responseStatus !== null && row.responseStatus >= 400);
          return (
            <span className={`font-mono ${isFailure ? "text-[color:var(--color-error)]" : ""}`}>
              {row.responseStatus ?? (row.error ? "ERR" : "—")}
            </span>
          );
        },
        meta: { className: "w-20" },
      },
      {
        accessorKey: "requestId",
        header: "Request",
        cell: (ctx) => {
          const v = ctx.getValue<string | null>();
          if (!v) return <span>—</span>;
          return (
            <button
              type="button"
              onClick={() => {
                setRequestId(v);
                const params = new URLSearchParams();
                params.set("requestId", v);
                router.replace(`/admin/pdns-requests?${params.toString()}`, {
                  scroll: false,
                });
              }}
              className="font-mono text-[color:var(--color-accent)] hover:underline"
            >
              {v.slice(0, 8)}…
            </button>
          );
        },
        meta: { className: "w-24" },
      },
    ],
    [router],
  );

  // Expandable row body — the PdnsHttpLog viewer rendered inline beneath the
  // row via DataTable's `renderRowDetail`, controlled by a Set of expanded ids.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Augment columns with an expander column at index 0.
  const columnsWithExpand = useMemo<Array<ColumnDef<PdnsRequestRowClient, unknown>>>(
    () => [
      {
        id: "expand",
        header: "",
        enableSorting: false,
        cell: (ctx) => {
          const id = ctx.row.original.id;
          const open = expanded.has(id);
          return (
            <button
              type="button"
              onClick={() => toggle(id)}
              aria-label={open ? "Collapse" : "Expand"}
              className="rounded px-1.5 text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)]"
            >
              {open ? "▾" : "▸"}
            </button>
          );
        },
        meta: { className: "w-8" },
      },
      ...columns,
    ],
    [columns, expanded],
  );

  return (
    <div className="space-y-4">
      {/* Filter form — controlled, never auto-submits. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
        className="grid gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-xs sm:grid-cols-4"
      >
        <Field label="Server">
          <SelectMenu
            value={serverSlug}
            onChange={setServerSlug}
            placeholder="all"
            ariaLabel="Server"
            className="w-full text-xs"
            options={props.slugChoices.map((s) => ({ value: s, label: s }))}
          />
        </Field>
        <Field label="Op">
          <SelectMenu
            value={op}
            onChange={setOp}
            placeholder="all"
            ariaLabel="Op"
            className="w-full text-xs"
            options={props.opChoices.map((o) => ({ value: o, label: o }))}
          />
        </Field>
        <Field label="Status">
          <input
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="200, 422, …"
            className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
          />
        </Field>
        <Field label="Request ID">
          <input
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
            placeholder="opaque id"
            className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-xs"
          />
        </Field>
        <Field label="From">
          <DateTimePicker
            value={fromIso}
            onChange={setFromIso}
            side="from"
            className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
          />
        </Field>
        <Field label="To">
          <DateTimePicker
            value={toIso}
            onChange={setToIso}
            side="to"
            className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
          />
        </Field>
        <div className="flex items-center gap-2 sm:col-span-4">
          <button
            type="submit"
            disabled={!filtersDirty}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={clearFilters}
            className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
          >
            Clear
          </button>
          {props.windowCapped ? (
            <span className="ml-auto text-[0.625rem] text-[color:var(--color-warn)]">
              Showing the most recent {props.rows.length} rows — narrow with filters to see older
              entries.
            </span>
          ) : null}
        </div>
      </form>

      <DataTable
        data={props.rows}
        columns={columnsWithExpand}
        pageSize={50}
        pageSizeOptions={[25, 50, 100, 200]}
        searchPlaceholder="Search URLs, ops, methods…"
        emptyMessage="No requests match the current filter."
        noDataMessage="No PowerDNS HTTP traffic recorded yet."
        sortParam="sort"
        pageSizeParam="pageSize"
        renderRowDetail={(row) =>
          expanded.has(row.id) ? (
            <PdnsHttpLog
              collapsible={false}
              entries={[
                {
                  id: row.id,
                  ts: row.ts,
                  serverSlug: row.serverSlug,
                  serverName: row.serverName,
                  serverDbId: row.serverDbId,
                  op: row.op,
                  method: row.method,
                  url: row.url,
                  requestHeaders: row.requestHeaders,
                  requestBody: row.requestBody,
                  responseStatus: row.responseStatus,
                  error: row.error,
                },
              ]}
            />
          ) : null
        }
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="block text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function shortenUrl(u: string): string {
  // Strip the scheme + host for readability — the operator is already
  // scoped to one (or a few) PDNS hosts and the path is the load-
  // bearing part.
  return u.replace(/^https?:\/\/[^/]+/, "");
}
