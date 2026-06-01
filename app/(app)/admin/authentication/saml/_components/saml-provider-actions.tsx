"use client";

/**
 * app/(app)/admin/authentication/saml/_components/saml-provider-actions.tsx
 *
 * Delete button for the SAML provider edit page. Mirrors the OIDC
 * equivalent - uses the in-app dialog system (no native confirm).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

interface ActionsProps {
  id: string;
  name: string;
}

export function SamlProviderActions({ id, name }: ActionsProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete provider "${name}"?`,
      description:
        "The provider is removed from the login page immediately. Audit history is preserved. This cannot be undone.",
      confirmLabel: "Delete provider",
      variant: "danger",
      dismissOnBackdrop: false,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/saml-providers/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({
          kind: "error",
          description: data?.error ?? "Delete failed.",
        });
        return;
      }
      toast({ kind: "success", description: "Provider deleted." });
      router.push("/admin/authentication");
      router.refresh();
    } catch {
      toast({ kind: "error", description: "Network error. Please try again." });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={deleting}
      className="mt-4 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)] px-4 py-2 text-sm font-medium text-white hover:opacity-95 disabled:opacity-50"
    >
      {deleting ? "Deleting…" : "Delete provider"}
    </button>
  );
}
