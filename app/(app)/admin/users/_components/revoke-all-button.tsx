"use client";

/**
 * app/(app)/admin/users/_components/revoke-all-button.tsx
 *
 * Incident-response button: wipe every session in the database,
 * forcing every signed-in user to re-authenticate. Lives at the
 * top of /admin/users next to "Add user" — visible only when the
 * operator has `user.update`, since the route gates on that.
 *
 * Two confirm steps:
 *   1. Standard `confirm` dialog with strong copy.
 *   2. A type-to-confirm gate ("type REVOKE to proceed") so the
 *      action doesn't fire on a single misclick. The `prompt`
 *      primitive from the DialogProvider handles this without
 *      needing window.prompt (feedback-no-native-dialogs).
 *
 * "Include my own session" is offered via a separate follow-up
 * prompt rather than packed into one dialog — keeps each step
 * focused on a single decision.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

export function RevokeAllSessionsButton() {
  const router = useRouter();
  const { confirm, prompt, toast } = useDialog();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    const okConfirm = await confirm({
      title: "Revoke EVERY session in the system?",
      description:
        "Use this when you need everyone to re-authenticate (suspected credential leak, compromised infrastructure, post-incident reset). All signed-in users will be kicked out and need to sign in again with their password / SSO. Accounts themselves are NOT disabled.",
      confirmLabel: "Continue",
      variant: "danger",
    });
    if (!okConfirm) return;

    // Type-to-confirm gate. Refuses anything other than the exact
    // string "REVOKE" (case-sensitive — the all-caps signals
    // "you're about to do something destructive").
    const typed = await prompt({
      title: "Type REVOKE to confirm",
      description:
        "This is a deliberately friction-y step. Type the word REVOKE exactly to confirm.",
      placeholder: "REVOKE",
      confirmLabel: "Confirm",
    });
    if (typed !== "REVOKE") {
      if (typed !== null) {
        toast({ kind: "error", description: "Confirmation text did not match. Aborted." });
      }
      return;
    }

    // Final question: include the operator's own session, or
    // spare it (default — keeps the audit-log window open mid-IR).
    const includeSelfChoice = await confirm({
      title: "Include your own session?",
      description:
        "Spare your session and keep working through the incident, OR sign yourself out alongside everyone else to enforce a uniform re-login.",
      confirmLabel: "Include mine too",
      cancelLabel: "Spare mine",
      variant: "danger",
    });

    setBusy(true);
    try {
      const url = includeSelfChoice ? "/api/admin/sessions?include-self=1" : "/api/admin/sessions";
      const result = await mutate(url, { method: "DELETE" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Revoke failed",
          description: result.error,
        });
        return;
      }
      const data = result.data as { revoked: number };
      toast({
        kind: "success",
        title: "Sessions revoked",
        description: `${data.revoked} session${data.revoked === 1 ? "" : "s"} cleared.`,
      });
      if (includeSelfChoice) {
        // The operator just signed themselves out — bounce to login
        // after a beat so they see the toast first.
        setTimeout(() => {
          window.location.assign("/login?flash=session-required");
        }, 1500);
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title="Force every signed-in user to re-authenticate. Use for incident response."
      className="rounded-md border border-[color:var(--color-error)] px-3 py-2 text-sm font-medium text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
    >
      {busy ? "Revoking…" : "Revoke all sessions"}
    </button>
  );
}
