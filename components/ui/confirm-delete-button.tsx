"use client";

/**
 * components/ui/confirm-delete-button.tsx
 *
 * Shared confirm-then-DELETE button. Collapses the near-identical
 * delete-role / delete-cluster / delete-server (etc.) components that each
 * re-implemented the same confirm → DELETE → toast → redirect/refresh flow.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

interface ConfirmDeleteButtonProps {
  /** DELETE target. */
  endpoint: string;
  confirmTitle: string;
  confirmDescription: string;
  confirmLabel: string;
  /** Toast description shown on success. */
  successMessage: string;
  /** Idle button label. */
  label: string;
  /** Label while the request is in flight. */
  busyLabel?: string;
  /** Navigate here on success before refreshing. Omit to refresh in place. */
  redirectTo?: string;
  className?: string;
}

const DEFAULT_CLASS =
  "rounded border border-[color:var(--color-error)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50";

export function ConfirmDeleteButton({
  endpoint,
  confirmTitle,
  confirmDescription,
  confirmLabel,
  successMessage,
  label,
  busyLabel = "Deleting…",
  redirectTo,
  className,
}: ConfirmDeleteButtonProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    const ok = await confirm({
      title: confirmTitle,
      description: confirmDescription,
      confirmLabel,
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await mutate(endpoint, { method: "DELETE" });
      if (!result.ok) {
        toast({ kind: "error", title: "Delete failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: successMessage });
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={busy}
      className={className ?? DEFAULT_CLASS}
    >
      {busy ? busyLabel : label}
    </button>
  );
}
