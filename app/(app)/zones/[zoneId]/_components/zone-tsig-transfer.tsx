"use client";

/**
 * app/(app)/zones/[zoneId]/_components/zone-tsig-transfer.tsx
 *
 * Per-zone TSIG keys for AXFR (the "on the zone detail page" half of zone-key
 * selection). Manages the zone's set of transfer keys: each call adds or removes
 * exactly ONE key via the tsig-transfer route, which read-modify-writes
 * `master_tsig_key_ids` on the primary + `slave_tsig_key_ids` on the secondaries
 * that host the zone - so other keys already on the zone are never clobbered.
 *
 * Shown only on authoritative (Master/Primary) zones; mirror zones get their
 * AXFR-MASTER-TSIG from their primary's view.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu } from "@/components/ui/select-menu";
import { mutate } from "@/lib/client/api-fetch";
import { stripTrailingDot } from "@/lib/pdns/tsig";

interface Props {
  zoneIdEncoded: string;
  serverSlug: string;
  /** TSIG key names available on this backend. */
  allKeys: string[];
  /** Keys currently securing this zone's AXFR (master_tsig_key_ids). */
  currentKeys: string[];
  canWrite: boolean;
}

export function ZoneTsigTransfer({
  zoneIdEncoded,
  serverSlug,
  allKeys,
  currentKeys,
  canWrite,
}: Props) {
  const router = useRouter();
  const { toast } = useDialog();
  const [keys, setKeys] = useState<string[]>(() => [...new Set(currentKeys.map(stripTrailingDot))]);
  const [busy, setBusy] = useState<string | null>(null);
  const [toAdd, setToAdd] = useState("");

  const available = [...new Set(allKeys.map(stripTrailingDot))].filter((k) => !keys.includes(k));

  async function change(rawKeyName: string, mode: "add" | "remove") {
    const keyName = stripTrailingDot(rawKeyName);
    setBusy(keyName);
    try {
      const res = await mutate(`/api/admin/pdns/zones/${zoneIdEncoded}/tsig-transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug, keyName, mode }),
      });
      if (!res.ok) {
        toast({ kind: "error", title: "Couldn't update transfer keys", description: res.error });
        return;
      }
      const data = res.data as {
        secondaries?: Array<{ hosted: boolean; ok: boolean }>;
      };
      const applied = (data.secondaries ?? []).filter((s) => s.hosted && s.ok).length;
      setKeys((prev) =>
        mode === "add" ? [...new Set([...prev, keyName])] : prev.filter((k) => k !== keyName),
      );
      setToAdd("");
      toast({
        kind: "success",
        title: mode === "add" ? "Key added" : "Key removed",
        description:
          mode === "add"
            ? `Primary + ${applied} secondary(ies) now accept "${keyName}" for AXFR.`
            : `"${keyName}" no longer required on primary + ${applied} secondary(ies).`,
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
      <h3 className="text-sm font-medium">Zone transfer (TSIG)</h3>
      <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
        Keys required for AXFR of this zone - sets <code>master_tsig_key_ids</code> here and{" "}
        <code>slave_tsig_key_ids</code> on the secondaries that mirror it. Adding or removing a key
        leaves any others in place.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {keys.length === 0 ? (
          <span className="text-xs text-[color:var(--color-fg-muted)]">
            No TSIG key - AXFR is unauthenticated.{" "}
            <Link
              href={`/admin/tsig-keys?server=${encodeURIComponent(serverSlug)}`}
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Manage TSIG keys
            </Link>
          </span>
        ) : (
          keys.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-2 py-0.5 font-mono text-xs"
            >
              {k}
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => void change(k, "remove")}
                  disabled={busy === k}
                  aria-label={`Remove ${k}`}
                  className="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-error)] disabled:opacity-50"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>

      {canWrite ? (
        <div className="mt-3 flex items-center gap-2">
          <SelectMenu
            value={toAdd}
            onChange={setToAdd}
            options={available.map((k) => ({ value: k, label: k }))}
            placeholder={available.length > 0 ? "Add a key…" : "All keys assigned"}
            disabled={available.length === 0 || busy !== null}
            ariaLabel="Add a TSIG key for transfer"
            className="min-w-48 font-mono"
          />
          <button
            type="button"
            onClick={() => toAdd && void change(toAdd, "add")}
            disabled={!toAdd || busy !== null}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
          >
            Add
          </button>
        </div>
      ) : null}

      {!canWrite ? (
        <p className="mt-2 text-xs text-[color:var(--color-fg-muted)]">
          Read-only - needs <code>metadata.write</code>.
        </p>
      ) : null}
    </div>
  );
}
