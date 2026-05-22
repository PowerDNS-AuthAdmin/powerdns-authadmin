"use client";

/**
 * app/(app)/admin/autoprimaries/_components/autoprimary-actions.tsx
 *
 * Inline Add form + per-row Delete. No secret material; the only
 * thing this component touches is connection-config tuples.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

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
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {creating ? "Adding…" : "Add"}
          </button>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">IP</th>
                <th className="px-4 py-2">Nameserver</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-3 font-mono text-xs">{row.ip}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.nameserver}</td>
                  <td className="px-4 py-3 text-xs text-[color:var(--color-fg-muted)]">
                    {row.account ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(row)}
                      disabled={deletingKey === rowKey(row)}
                      className="rounded border border-[color:var(--color-error)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                    >
                      {deletingKey === rowKey(row) ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
