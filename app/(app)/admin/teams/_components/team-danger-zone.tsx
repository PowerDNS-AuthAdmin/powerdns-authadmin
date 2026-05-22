"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

export function TeamDangerZone({ teamId, teamName }: { teamId: string; teamName: string }) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete team "${teamName}"?`,
      description:
        "Members are removed automatically. Role assignments referencing this team will stop matching. Audit history is preserved. This cannot be undone.",
      confirmLabel: "Delete team",
      variant: "danger",
      dismissOnBackdrop: false,
    });
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/teams/${teamId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg = data?.error ?? "Delete failed.";
        setError(msg);
        toast({ kind: "error", title: "Delete failed", description: msg });
        return;
      }
      toast({ kind: "success", description: "Team deleted." });
      router.push("/admin/teams");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-md border border-[color:var(--color-error)] p-5">
      <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-error)] uppercase">
        Danger zone
      </h2>
      <p className="mt-2 text-sm text-[color:var(--color-fg-muted)]">
        Deleting a team removes its members. Audit history is preserved.
      </p>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="mt-3 rounded-md border border-[color:var(--color-error)] px-3 py-2 text-sm text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
      >
        {deleting ? "Deleting…" : "Delete team"}
      </button>
      {error ? (
        <p className="mt-2 text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
