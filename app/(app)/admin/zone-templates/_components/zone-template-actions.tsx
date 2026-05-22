"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

export function ZoneTemplateActions({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete template "${name}"?`,
      description:
        "Removes the template definition. Zones already created from it keep their records — templates are a creation-time scaffold, not a live link.",
      confirmLabel: "Delete template",
      variant: "danger",
      dismissOnBackdrop: false,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/zone-templates/${id}`, {
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
      toast({ kind: "success", description: "Template deleted." });
      router.push("/admin/zone-templates");
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
      {deleting ? "Deleting…" : "Delete template"}
    </button>
  );
}
