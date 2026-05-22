"use client";

/**
 * app/(app)/profile/_components/sessions-list.tsx
 *
 * Render the signed-in user's active sessions and offer per-row revocation.
 * Refreshes the page after a successful revoke so the list reflects state.
 *
 * We don't try to identify "this is your current session" here — that
 * requires reading the session cookie which is HttpOnly.can add
 * a server-prop pass for "current session id".
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
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

  if (sessions.length === 0) {
    return <p className="text-sm text-[color:var(--color-fg-muted)]">No active sessions.</p>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          <tr>
            <th className="px-4 py-2">Last seen</th>
            <th className="px-4 py-2">IP</th>
            <th className="px-4 py-2">User agent</th>
            <th className="px-4 py-2">Expires</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-t border-[color:var(--color-border)] align-top">
              <td className="px-4 py-3 text-xs">
                <LocalTime ts={s.lastSeenAt} />
              </td>
              <td className="px-4 py-3 font-mono text-xs">{s.ip ?? "—"}</td>
              <td className="px-4 py-3 text-xs">
                <span className="line-clamp-2 max-w-[36ch]">{s.userAgent ?? "—"}</span>
              </td>
              <td className="px-4 py-3 text-xs">
                <LocalTime ts={s.expiresAt} />
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => revoke(s.id)}
                  disabled={busy === s.id}
                  className="text-xs text-[color:var(--color-error)] hover:underline disabled:opacity-50"
                >
                  {busy === s.id ? "Revoking…" : "Revoke"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
