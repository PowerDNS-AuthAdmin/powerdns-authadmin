"use client";

/**
 * app/(app)/dashboard/_components/unverified-email-banner.tsx
 *
 * Reminder + send-verification trigger for users with no
 * `email_verified_at`. Dismissible per-session via local state;
 * reappears on next page load so the operator can't forget.
 */

import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

export function UnverifiedEmailBanner() {
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  async function handleSend() {
    setBusy(true);
    try {
      const result = await mutate(`/api/auth/email/send-verification`, {
        method: "POST",
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Send failed",
          description: result.error,
        });
        return;
      }
      const data = result.data as { message: string };
      toast({ kind: "success", description: data.message, durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm">
      <div>
        <strong>Your email isn't verified.</strong>{" "}
        <span className="text-[color:var(--color-fg-muted)]">
          Send a verification link to confirm your address. Your administrator will share it with
          you out-of-band until transactional email is configured.
        </span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSend}
          disabled={busy}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send verification link"}
        </button>
        <button
          type="button"
          onClick={() => setHidden(true)}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
