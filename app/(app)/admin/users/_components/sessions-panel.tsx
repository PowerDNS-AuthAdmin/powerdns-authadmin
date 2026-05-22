"use client";

/**
 * app/(app)/admin/users/_components/sessions-panel.tsx
 *
 * Admin view + management of a user's active sessions. Mirrors the
 * shape of the self-service "Active sessions" block in /profile but
 * works on behalf of another user.
 *
 * Use cases:
 *   - "User reported their laptop was stolen" → revoke that one row.
 *   - "Suspected credential compromise; rotate while investigating"
 *     → revoke all (keeps the account active so they can sign in
 *     again after a password reset).
 *   - "Stale session list noise" → spot-revoke a particular row.
 *
 * Date strings are pre-formatted on the server (`*Display` props) and
 * rendered inside <span suppressHydrationWarning> so a client-side
 * locale mismatch can't blank the .dark class on <html>
 * (project-hydration-locale-dates memory).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { mutate } from "@/lib/client/api-fetch";

interface SessionRow {
  id: string;
  /** ISO 8601 UTC — rendered client-side via <LocalTime>. */
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface Props {
  userId: string;
  canManage: boolean;
  /**
   * True when the admin is looking at their OWN account. Used to
   * inject "you are about to sign yourself out" warnings into the
   * confirm copy so an operator doesn't accidentally lock themselves
   * out by clicking "Revoke all" on their own sessions list. The
   * action is still allowed (deliberately permitted self-
   * revoke for IR scenarios) — this is just a clearer guardrail.
   */
  isSelf: boolean;
  sessions: SessionRow[];
}

export function SessionsPanel({ userId, canManage, isSelf, sessions }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  // "all" is a sentinel for the bulk-revoke button; any other string is a
  // session row id. Keeping it as a plain string avoids a redundant
  // union with the literal, and the value space is closed by the
  // setters below.
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleRevokeOne(sessionId: string) {
    const ok = await confirm({
      title: "Revoke this session?",
      description: isSelf
        ? "If this is the session you're currently using, you'll be signed out the next time you hit the server."
        : "The browser or app using this session will be signed out the next time it hits the server. The user can sign in again right away.",
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(sessionId);
    try {
      const result = await mutate(`/api/admin/users/${userId}/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Revoke failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Session revoked." });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevokeAll() {
    if (sessions.length === 0) return;
    const ok = await confirm({
      title: isSelf
        ? `Revoke all ${sessions.length} of your sessions?`
        : `Revoke all ${sessions.length} sessions?`,
      description: isSelf
        ? "This includes the session you're using right now — you'll be signed out immediately. Sign in again with your password / SSO afterwards. The account itself stays active."
        : "Every browser or app signed in as this user will be kicked out. The account stays active — the user can sign in again with their password / SSO.",
      confirmLabel: isSelf ? "Sign me out everywhere" : "Revoke all",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId("all");
    try {
      const result = await mutate(`/api/admin/users/${userId}/sessions`, {
        method: "DELETE",
      });
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
        description: `Revoked ${data.revoked} session${data.revoked === 1 ? "" : "s"}.`,
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-md border border-[color:var(--color-border)] p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Sessions ({sessions.length})
        </h2>
        {canManage && sessions.length > 0 ? (
          <button
            type="button"
            onClick={handleRevokeAll}
            disabled={busyId !== null}
            className="rounded border border-[color:var(--color-error)] px-3 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
          >
            {busyId === "all" ? "Revoking…" : "Revoke all"}
          </button>
        ) : null}
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No active sessions.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                <div className="truncate font-mono text-[color:var(--color-fg-muted)]">
                  {s.ip ?? "ip-unknown"}
                  {" · "}
                  last seen <LocalTime ts={s.lastSeenAt} />
                </div>
                <div className="truncate text-[color:var(--color-fg-muted)]">
                  {s.userAgent ?? "no user-agent"}
                </div>
                <div className="text-[color:var(--color-fg-subtle)]">
                  expires <LocalTime ts={s.expiresAt} />
                </div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => handleRevokeOne(s.id)}
                  disabled={busyId !== null}
                  className="shrink-0 rounded border border-[color:var(--color-error)] px-2 py-1 text-[0.6875rem] text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                >
                  {busyId === s.id ? "Revoking…" : "Revoke"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
