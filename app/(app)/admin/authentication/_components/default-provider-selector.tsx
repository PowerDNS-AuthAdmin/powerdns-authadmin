"use client";

/**
 * app/(app)/admin/authentication/_components/default-provider-selector.tsx
 *
 * Themed dropdown that picks the global default sign-in method. Replaces
 * the per-provider `force_default` checkbox the old OIDC form carried.
 *
 * Value shape (mirrors `settings.auth_default_provider`):
 *   - "local"
 *   - "oidc:<slug>" / "saml:<slug>" / "ldap:<slug>"
 *
 * Save is a single-key PATCH to /api/admin/settings - same endpoint the
 * site-wide Settings form uses. The dropdown is themed via <SelectMenu>
 * (no native <select>) for consistency with the rest of the admin UI.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu } from "@/components/ui/select-menu";
import { mutate } from "@/lib/client/api-fetch";

export interface DefaultProviderOption {
  /** Setting value form: "local" or "<type>:<slug>". */
  value: string;
  /** Provider display name (primary line in the dropdown). */
  label: string;
  /** Issuer URL / human description (secondary line). */
  description: string;
  /** Local / OIDC / SAML / LDAP - surfaced as a small chip in the label. */
  protocol: string;
}

interface Props {
  initial: string;
  options: DefaultProviderOption[];
  canEdit: boolean;
}

export function DefaultProviderSelector({ initial, options, canEdit }: Props) {
  const router = useRouter();
  const { toast } = useDialog();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  const dirty = value !== initial;

  // The setting may resolve to a value whose backing provider no longer
  // exists (deleted after being set as default). Show a synthetic "stale"
  // option in that case so the picker is still usable.
  const allOptions: DefaultProviderOption[] = options.some((o) => o.value === initial)
    ? options
    : [
        {
          value: initial,
          label: initial === "local" ? "Local Auth" : initial,
          description: "(provider no longer exists)",
          protocol: initial.split(":")[0]?.toUpperCase() ?? "?",
        },
        ...options,
      ];

  async function handleSave() {
    setBusy(true);
    try {
      const result = await mutate(`/api/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth_default_provider: value }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Save failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Default sign-in method updated." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <label className="flex-1">
        <span className="block text-sm font-medium">Default sign-in method</span>
        <span className="mt-0.5 mb-2 block text-xs text-[color:var(--color-fg-muted)]">
          When set to anything other than Local Auth, <code>/login</code> auto-redirects to that
          provider's initiate URL. Escape hatch: <code>/login?force-local=1</code>.
        </span>
        <SelectMenu
          value={value}
          onChange={(v) => setValue(v)}
          options={allOptions.map((o) => ({
            value: o.value,
            label: `${o.label} [${o.protocol}]`,
            description: o.description,
          }))}
          disabled={!canEdit || busy}
          ariaLabel="Default sign-in method"
          className="text-sm"
        />
      </label>
      {canEdit ? (
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || busy}
          className="shrink-0 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      ) : null}
    </div>
  );
}
