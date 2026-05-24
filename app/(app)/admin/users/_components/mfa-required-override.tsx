"use client";

/**
 * Per-user MFA policy override. Tri-state select bound to the user's
 * `mfaRequired` column (null = inherit, true = require, false = exempt). The
 * override supersedes the user's role `requiresMfa` flags AND the SSO
 * exemption — see lib/auth/mfa-compliance.ts.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu } from "@/components/ui/select-menu";
import { mutate } from "@/lib/client/api-fetch";

type Choice = "inherit" | "require" | "exempt";

function toChoice(v: boolean | null): Choice {
  return v === true ? "require" : v === false ? "exempt" : "inherit";
}
function toValue(c: Choice): boolean | null {
  return c === "require" ? true : c === "exempt" ? false : null;
}

export function MfaRequiredOverride({
  userId,
  initial,
}: {
  userId: string;
  initial: boolean | null;
}) {
  const router = useRouter();
  const { toast } = useDialog();
  const current = toChoice(initial);
  const [choice, setChoice] = useState<Choice>(current);
  const [busy, setBusy] = useState(false);
  const dirty = choice !== current;

  async function handleSave() {
    setBusy(true);
    try {
      const result = await mutate(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaRequired: toValue(choice) }),
      });
      if (!result.ok) {
        toast({ kind: "error", title: "Save failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: "MFA policy updated for this user." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-end justify-between gap-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
      <label className="flex-1 text-sm">
        <span className="font-medium">Require MFA (per-user override)</span>
        <span className="mt-0.5 mb-2 block text-xs text-[color:var(--color-fg-muted)]">
          Supersedes this user&apos;s roles and the SSO exemption. “Inherit” falls back to the role
          policy.
        </span>
        <SelectMenu
          value={choice}
          onChange={(v) => setChoice(v)}
          options={[
            { value: "inherit", label: "Inherit from roles" },
            { value: "require", label: "Always require" },
            { value: "exempt", label: "Never require (exempt)" },
          ]}
          disabled={busy}
          ariaLabel="Require MFA (per-user override)"
          className="text-sm"
        />
      </label>
      <button
        type="button"
        onClick={handleSave}
        disabled={!dirty || busy}
        className="shrink-0 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
