"use client";

/**
 * app/(app)/admin/autoprimaries/_components/autoprimary-actions.tsx
 *
 * Inline Add form + per-row Delete. No secret material; the only
 * thing this component touches is connection-config tuples.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { createCtaClass } from "@/components/ui/create-button";
import { DataTable } from "@/components/ui/data-table";

interface Row {
  ip: string;
  nameserver: string;
  account?: string;
}

interface Props {
  serverSlug: string;
  rows: Row[];
}

export function AutoprimaryActions({ serverSlug, rows }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [ip, setIp] = useState("");
  const [nameserver, setNameserver] = useState("");
  const [account, setAccount] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  function rowKey(r: Row): string {
    // Unique enough for keying the per-row state — the (ip, nameserver)
    // pair is the PDNS-side compound primary key.
    return `${r.ip}|${r.nameserver}`;
  }

  async function handleCreate() {
    if (!ip.trim() || !nameserver.trim()) {
      toast({ kind: "error", description: "IP and nameserver are required." });
      return;
    }
    setCreating(true);
    try {
      const result = await mutate(`/api/admin/pdns/autoprimaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverSlug,
          ip: ip.trim(),
          nameserver: nameserver.trim(),
          ...(account.trim() ? { account: account.trim() } : {}),
        }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Add failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Autoprimary added." });
      setIp("");
      setNameserver("");
      setAccount("");
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(row: Row) {
    const ok = await confirm({
      title: `Remove autoprimary ${row.nameserver} (${row.ip})?`,
      description:
        "New NOTIFYs from this primary will no longer trigger automatic slave-zone creation. Existing slave zones are unaffected.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    const key = rowKey(row);
    setDeletingKey(key);
    try {
      const url = new URL("/api/admin/pdns/autoprimaries", window.location.origin);
      url.searchParams.set("serverSlug", serverSlug);
      url.searchParams.set("ip", row.ip);
      url.searchParams.set("nameserver", row.nameserver);
      const result = await mutate(url.pathname + url.search, { method: "DELETE" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Remove failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Removed." });
      router.refresh();
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
        <h2 className="text-sm font-medium">Add an autoprimary</h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          PDNS will accept NOTIFYs from this (IP, nameserver) pair and auto-create slave zones for
          any zone the primary serves. `account` is an optional free-form label.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_max-content] sm:items-end">
          <div>
            <label htmlFor="ap-ip" className="block text-xs font-medium">
              IP
            </label>
            <input
              id="ap-ip"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.0.2.10"
              className="mt-1 block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-sm"
            />
          </div>
          <div>
            <label htmlFor="ap-ns" className="block text-xs font-medium">
              Nameserver
            </label>
            <input
              id="ap-ns"
              value={nameserver}
              onChange={(e) => setNameserver(e.target.value)}
              placeholder="ns1.example."
              className="mt-1 block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-sm"
            />
          </div>
          <div>
            <label htmlFor="ap-account" className="block text-xs font-medium">
              Account (optional)
            </label>
            <input
              id="ap-account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="customer-x"
              className="mt-1 block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className={`${createCtaClass} disabled:opacity-50`}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {creating ? "Adding…" : "Add"}
          </button>
        </div>
      </div>

      <AutoprimariesTable
        serverSlug={serverSlug}
        rows={rows}
        onDelete={handleDelete}
        busyKey={deletingKey}
        rowKey={rowKey}
      />
    </section>
  );
}

function AutoprimariesTable({
  serverSlug,
  rows,
  onDelete,
  busyKey,
  rowKey,
}: {
  serverSlug: string;
  rows: Row[];
  onDelete: (row: Row) => void;
  busyKey: string | null;
  rowKey: (row: Row) => string;
}) {
  const columns = useMemo<Array<ColumnDef<Row, unknown>>>(
    () => [
      {
        accessorKey: "ip",
        header: "IP",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "nameserver",
        header: "Nameserver",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "account",
        header: "Account",
        cell: (ctx) => (
          <span className="text-xs text-[color:var(--color-fg-muted)]">
            {ctx.getValue<string | undefined>() ?? "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (ctx) => {
          const row = ctx.row.original;
          const busy = busyKey === rowKey(row);
          return (
            <button
              type="button"
              onClick={() => onDelete(row)}
              disabled={busy}
              className="rounded border border-[color:var(--color-error)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
            >
              {busy ? "Removing…" : "Remove"}
            </button>
          );
        },
      },
    ],
    [busyKey, onDelete, rowKey],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={Math.max(rows.length, 10)}
      hidePagination
      hideSearch
      noDataMessage={`No autoprimaries configured on ${serverSlug}. Incoming NOTIFYs that don't match an existing zone are ignored.`}
      emptyMessage="No autoprimaries match."
      stateKey="autoprimaries"
    />
  );
}
