"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

interface Member {
  userId: string;
  email: string;
  name: string | null;
  teamRole: "owner" | "member";
  addedAt: string;
}

interface PanelProps {
  teamId: string;
  canManage: boolean;
  members: Member[];
}

export function TeamMembersPanel(props: PanelProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [email, setEmail] = useState("");
  const [teamRole, setTeamRole] = useState<"owner" | "member">("member");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/teams/${props.teamId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, teamRole }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not add member.");
        return;
      }
      setEmail("");
      toast({ kind: "success", description: "Member added." });
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    const ok = await confirm({
      title: "Remove this member?",
      description: "They lose access scoped through this team. Their account stays active.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setRemoving(userId);
    try {
      const result = await mutate(`/api/admin/teams/${props.teamId}/members/${userId}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Could not remove member",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Member removed." });
      router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  async function handleSetRole(userId: string, next: "owner" | "member") {
    const result = await mutate(`/api/admin/teams/${props.teamId}/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamRole: next }),
    });
    if (!result.ok) {
      toast({
        kind: "error",
        title: "Could not update role",
        description: result.error,
      });
      return;
    }
    toast({ kind: "success", description: `Role set to ${next}.` });
    router.refresh();
  }

  return (
    <section className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Members ({props.members.length})
        </h2>
      </header>

      {props.members.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No members yet.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Joined</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {props.members.map((m) => (
                <tr key={m.userId} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-3">
                    <div className="font-medium">{m.email}</div>
                    {m.name ? (
                      <div className="text-xs text-[color:var(--color-fg-muted)]">{m.name}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {props.canManage ? (
                      <select
                        value={m.teamRole}
                        onChange={(e) =>
                          handleSetRole(m.userId, e.target.value as "owner" | "member")
                        }
                        className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
                      >
                        <option value="member">member</option>
                        <option value="owner">owner</option>
                      </select>
                    ) : (
                      m.teamRole
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <LocalTime ts={m.addedAt} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {props.canManage ? (
                      <button
                        type="button"
                        onClick={() => handleRemove(m.userId)}
                        disabled={removing === m.userId}
                        className="text-xs text-[color:var(--color-error)] hover:underline disabled:opacity-50"
                      >
                        {removing === m.userId ? "Removing…" : "Remove"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {props.canManage ? (
        <form
          onSubmit={handleAdd}
          className="space-y-3 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4"
        >
          <p className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Add member
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_max-content_max-content]">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm"
            />
            <select
              value={teamRole}
              onChange={(e) => setTeamRole(e.target.value as "owner" | "member")}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm"
            >
              <option value="member">member</option>
              <option value="owner">owner</option>
            </select>
            <button
              type="submit"
              disabled={adding}
              className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          {error ? (
            <p className="text-xs text-[color:var(--color-error)]" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
