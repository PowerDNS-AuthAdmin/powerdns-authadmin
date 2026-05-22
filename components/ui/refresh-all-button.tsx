"use client";

/**
 * components/ui/refresh-all-button.tsx
 *
 * Shared "Refresh all" fleet button. Collapses the duplicated scaffolding
 * (busy state, POST, error toast, router.refresh, button markup) the OIDC and
 * PDNS-servers refresh-all buttons each carried. The per-feature success copy
 * is supplied via `successToast`, which maps the response payload to a toast.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

interface RefreshAllButtonProps<T> {
  /** POST target. */
  endpoint: string;
  /** Native title/tooltip. */
  title: string;
  /** Maps the success payload to the toast to show. */
  successToast: (data: T) => { kind: "success" | "error"; title: string; description: string };
  className?: string;
}

const DEFAULT_CLASS =
  "rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50";

export function RefreshAllButton<T = unknown>({
  endpoint,
  title,
  successToast,
  className,
}: RefreshAllButtonProps<T>) {
  const router = useRouter();
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const result = await mutate<T>(endpoint, { method: "POST" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Refresh failed to dispatch",
          description: "Check your permissions or reload the page.",
        });
        return;
      }
      toast(successToast(result.data));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={title}
      className={className ?? DEFAULT_CLASS}
    >
      {busy ? "Refreshing…" : "Refresh all"}
    </button>
  );
}
