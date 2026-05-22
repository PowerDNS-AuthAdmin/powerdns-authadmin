"use client";

/**
 * app/(app)/admin/tsig-keys/_components/tsig-actions.tsx
 *
 * "Add key" form + per-row Delete button + shown-once secret panel
 * after a successful create. All routes the component talks to are
 * CSRF-gated by `apiFetch`.
 *
 * The fresh-from-create secret follows the S-8 reveal pattern:
 *   1. POST /api/admin/pdns/tsig-keys → server returns a reveal
 *      token (no plaintext key in the JSON body).
 *   2. POST /api/admin/pdns/tsig-keys/[id]/reveal with the token →
 *      server returns the plaintext HMAC as `text/plain` exactly
 *      once. We display it in the "shown once" panel and discard
 *      the variable as soon as the panel is dismissed.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

const ALGORITHMS = [
  "hmac-sha256",
  "hmac-sha512",
  "hmac-sha384",
  "hmac-sha224",
  "hmac-sha1",
  "hmac-md5",
] as const;

interface Row {
  id: string;
  name: string;
  algorithm: string;
}

interface Props {
  serverSlug: string;
  rows: Row[];
}

export function TsigActions({ serverSlug, rows }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState<(typeof ALGORITHMS)[number]>("hmac-sha256");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{
    name: string;
    algorithm: string;
    secret: string;
  } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      toast({ kind: "error", description: "Enter a name." });
      return;
    }
    setCreating(true);
    setRevealed(null);
    try {
      const result = await mutate(`/api/admin/pdns/tsig-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug, name: name.trim(), algorithm }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Create failed",
          description: result.error,
        });
        return;
      }
      const minted = result.data as {
        tsigKey: { id: string; name: string; algorithm: string };
        revealToken: string;
      };

      // Immediately redeem the reveal token. The plaintext lives only
      // in the `revealed` state until the operator dismisses the panel.
      const revealRes = await apiFetch(
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(minted.tsigKey.id)}/reveal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: minted.revealToken }),
        },
      );
      if (!revealRes.ok) {
        toast({
          kind: "error",
          title: "Reveal failed",
          description:
            "Key created but the one-time secret could not be retrieved. Delete and re-create.",
        });
        router.refresh();
        return;
      }
      const secret = await revealRes.text();
      setRevealed({
        name: minted.tsigKey.name,
        algorithm: minted.tsigKey.algorithm,
        secret,
      });
      setName("");
      toast({
        kind: "success",
        description: "Key created. Secret shown below.",
      });
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(row: Row) {
    const ok = await confirm({
      title: `Delete TSIG key ${row.name}?`,
      description:
        "Any zone metadata that references this key by name (TSIG-ALLOW-AXFR, AXFR-MASTER-TSIG) will start rejecting transfers. This cannot be undone.",
      confirmLabel: "Delete key",
      variant: "danger",
      dismissOnBackdrop: false,
    });
    if (!ok) return;
    setDeletingId(row.id);
    try {
      const url = new URL(
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(row.id)}`,
        window.location.origin,
      );
      url.searchParams.set("serverSlug", serverSlug);
      const result = await mutate(url.pathname + url.search, { method: "DELETE" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Delete failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: `Deleted ${row.name}.` });
      router.refresh();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
        <h2 className="text-sm font-medium">Add a key</h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          PDNS generates the HMAC secret server-side. The plaintext is shown once after creation and
          never again.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="grow basis-64">
            <label htmlFor="tsig-name" className="block text-xs font-medium">
              Name
            </label>
            <input
              id="tsig-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="primary-to-secondary"
              className="mt-1 block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-sm"
            />
          </div>
          <div>
            <label htmlFor="tsig-algo" className="block text-xs font-medium">
              Algorithm
            </label>
            <select
              id="tsig-algo"
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as (typeof ALGORITHMS)[number])}
              className="mt-1 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-sm"
            >
              {ALGORITHMS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {creating ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>

      {revealed ? (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Generated TSIG key — shown once</p>
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                Copy now and store in your secondary's config. Reloading this page will not show it
                again.
              </p>
            </div>
            <button type="button" onClick={() => setRevealed(null)} className="text-xs underline">
              Dismiss
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-[color:var(--color-fg-muted)]">Name</dt>
            <dd className="font-mono">{revealed.name}</dd>
            <dt className="text-[color:var(--color-fg-muted)]">Algorithm</dt>
            <dd className="font-mono">{revealed.algorithm}</dd>
            <dt className="text-[color:var(--color-fg-muted)]">Secret</dt>
            <dd>
              <code className="block rounded bg-[color:var(--color-bg)] p-2 font-mono text-xs break-all">
                {revealed.secret}
              </code>
            </dd>
          </dl>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Algorithm</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-3 font-mono text-xs">{row.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-xs">
                      {row.algorithm}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(row)}
                      disabled={deletingId === row.id}
                      className="rounded border border-[color:var(--color-error)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                    >
                      {deletingId === row.id ? "Deleting…" : "Delete"}
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
