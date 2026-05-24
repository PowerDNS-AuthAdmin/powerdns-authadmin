"use client";

/**
 * app/(app)/admin/tsig-keys/_components/tsig-actions.tsx
 *
 * Per-backend TSIG key table + the entry points that mutate it:
 *   • "Create key" — opens the wizard (generate → install → secure zones).
 *   • per-row "Set up" — re-opens the wizard at the install step for an existing
 *     key (e.g. after adding a secondary).
 *   • per-row "Delete" — cascade-deletes by default (strips the key from zones +
 *     secondaries), or key-only when the operator opts out.
 *
 * The one-time secret is never shown here — it lives only inside the wizard's
 * manual step (re-fetched server-side as text/plain). Routes are CSRF-gated by
 * `apiFetch`/`mutate`.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { TsigKeyWizard, type InstallSecondary } from "./tsig-key-wizard";

interface Row {
  id: string;
  name: string;
  algorithm: string;
}

interface Props {
  serverSlug: string;
  /** The backend's keys, or null when the list couldn't be fetched (the page
   *  shows the error separately — we suppress the table in that case). */
  rows: Row[] | null;
  /** This backend is a write-target primary (replication makes sense here). */
  isPrimary: boolean;
  /** The primary's secondaries (for API install) — empty unless `isPrimary`. */
  secondaries: InstallSecondary[];
  /** The primary's authoritative zone names (for in-flow key activation). */
  zones: string[];
}

type WizardState = { mode: "create" } | { mode: "existing"; keyId: string; keyName: string };

export function TsigActions({ serverSlug, rows, isPrimary, secondaries, zones }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);

  // Per-row "Set up" only makes sense from a primary with somewhere to install
  // (managed secondaries) or zones to activate the key for.
  const canInstall = isPrimary && (secondaries.length > 0 || zones.length > 0);

  async function handleDelete(row: Row) {
    const { confirmed, checked: cascade } = await confirm({
      title: `Delete TSIG key ${row.name}?`,
      description: (
        <span className="flex items-start gap-2">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warn)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            All zone transfers (AXFR) for zones using this key will not be secure. This cannot be
            undone, a new key will have to be generated.
          </span>
        </span>
      ),
      confirmLabel: "Delete key",
      variant: "danger",
      dismissOnBackdrop: false,
      checkbox: {
        label: "Also delete key from all zones configured to use it, and cleanup secondaries",
        defaultChecked: true,
        warningWhenUnchecked: "Zones still referencing this key will reject transfers",
      },
    });
    if (!confirmed) return;
    setDeletingId(row.id);
    try {
      const url = new URL(
        `/api/admin/pdns/tsig-keys/${encodeURIComponent(row.id)}`,
        window.location.origin,
      );
      url.searchParams.set("serverSlug", serverSlug);
      url.searchParams.set("cascade", cascade ? "true" : "false");
      const result = await mutate(url.pathname + url.search, { method: "DELETE" });
      if (!result.ok) {
        toast({ kind: "error", title: "Delete failed", description: result.error });
        return;
      }
      const summary = result.data as {
        cascade?: { zonesUpdated: number; secondariesCleaned: number } | null;
      };
      toast({
        kind: "success",
        description: summary.cascade
          ? `Deleted ${row.name} — cleaned ${summary.cascade.zonesUpdated} zone(s) and ${summary.cascade.secondariesCleaned} secondary(ies).`
          : `Deleted ${row.name}.`,
      });
      router.refresh();
    } finally {
      setDeletingId(null);
    }
  }

  // null rows = the list couldn't be fetched (the page shows the error); the
  // table is suppressed in that case, but "Create key" stays available.
  const keys = rows ?? [];

  return (
    <section className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setWizard({ mode: "create" })}
          className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Create key
        </button>
      </div>

      {rows !== null ? (
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
              {keys.map((row) => (
                <tr key={row.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-3 font-mono text-xs">{row.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-xs">
                      {row.algorithm}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      {canInstall ? (
                        <button
                          type="button"
                          onClick={() =>
                            setWizard({ mode: "existing", keyId: row.id, keyName: row.name })
                          }
                          className="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
                        >
                          Set up
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => handleDelete(row)}
                        disabled={deletingId === row.id}
                        className="rounded border border-[color:var(--color-error)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                      >
                        {deletingId === row.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {keys.length === 0 ? (
                <tr className="border-t border-[color:var(--color-border)]">
                  <td
                    colSpan={3}
                    className="px-4 py-6 text-center text-[color:var(--color-fg-muted)]"
                  >
                    No TSIG keys configured on <code>{serverSlug}</code>. AXFR and NOTIFY between
                    this backend and its peers happens without shared-secret authentication.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {wizard ? (
        <TsigKeyWizard
          serverSlug={serverSlug}
          secondaries={secondaries}
          zones={zones}
          existing={
            wizard.mode === "existing"
              ? { keyId: wizard.keyId, keyName: wizard.keyName }
              : undefined
          }
          onChanged={() => router.refresh()}
          onClose={() => {
            setWizard(null);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
