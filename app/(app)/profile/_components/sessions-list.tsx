"use client";

/**
 * app/(app)/profile/_components/sessions-list.tsx
 *
 * Render the signed-in user's active sessions and offer per-row revocation.
 * Refreshes the page after a successful revoke so the list reflects state.
 *
 * We don't try to identify "this is your current session" here — that
 * requires reading the session cookie which is HttpOnly. can add a
 * server-prop pass for "current session id".
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { mutate } from "@/lib/client/api-fetch";

interface SessionSummary {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}

export function SessionsList({ sessions }: { sessions: SessionSummary[] }) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(id: string) {
    const ok = await confirm({
      title: "Revoke this session?",
      description: "The browser holding it will be signed out on its next request.",
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(id);
    try {
      const result = await mutate(`/api/auth/sessions/${id}`, { method: "DELETE" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Could not revoke session",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Session revoked." });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const columns = useMemo<Array<ColumnDef<SessionSummary, unknown>>>(
    () => [
      {
        accessorKey: "lastSeenAt",
        header: "Last seen",
        cell: (ctx) => <LocalTime ts={ctx.getValue<string>()} className="text-xs" />,
        meta: { className: "w-44" },
      },
      {
        accessorKey: "ip",
        header: "IP",
        cell: (ctx) => (
          <span className="font-mono text-xs">{ctx.getValue<string | null>() ?? "—"}</span>
        ),
        meta: { className: "w-44" },
      },
      {
        accessorKey: "userAgent",
        header: "User agent",
        cell: (ctx) => (
          <span className="line-clamp-2 max-w-[36ch] text-xs">
            {ctx.getValue<string | null>() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: (ctx) => <LocalTime ts={ctx.getValue<string>()} className="text-xs" />,
        meta: { className: "w-44" },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <button
              type="button"
              onClick={() => revoke(row.id)}
              disabled={busy === row.id}
              className="text-xs text-[color:var(--color-error)] hover:underline disabled:opacity-50"
            >
              {busy === row.id ? "Revoking…" : "Revoke"}
            </button>
          );
        },
      },
    ],
    // `revoke` closes over busy + the dialog/toast/router refs; rebuilt each
    // render is fine for a short list, and avoids stale-busy reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  );

  return (
    <DataTable
      data={sessions}
      columns={columns}
      pageSize={Math.max(sessions.length, 10)}
      hidePagination
      hideSearch
      noDataMessage="No active sessions."
      emptyMessage="No active sessions."
      stateKey="profile-sessions"
    />
  );
}
