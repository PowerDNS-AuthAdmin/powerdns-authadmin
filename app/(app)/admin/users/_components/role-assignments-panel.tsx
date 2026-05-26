"use client";

/**
 * app/(app)/admin/users/_components/role-assignments-panel.tsx
 *
 * Show existing role assignments and let an authorized actor add or remove
 * them. Scope picker is conditional on the chosen scope type.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

interface Assignment {
  assignmentId: string;
  roleSlug: string;
  roleName: string;
  isSystem: boolean;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
  scopeLabel: string;
  createdAt: string;
}

interface RoleOption {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
}

interface NamedRow {
  id: string;
  name: string;
}

interface PanelProps {
  userId: string;
  canManage: boolean;
  assignments: Assignment[];
  roles: RoleOption[];
  teams: NamedRow[];
  servers: NamedRow[];
}

export function RoleAssignmentsPanel(props: PanelProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [roleId, setRoleId] = useState<string>(props.roles[0]?.id ?? "");
  const [scopeType, setScopeType] = useState<"global" | "team" | "server">("global");
  const [scopeId, setScopeId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scopeOptions = useMemo(() => {
    if (scopeType === "team") return props.teams;
    if (scopeType === "server") return props.servers;
    return [];
  }, [scopeType, props.teams, props.servers]);

  async function handleAssign() {
    if (!roleId) {
      setError("Pick a role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: { roleId: string; scopeType: string; scopeId?: string } = {
        roleId,
        scopeType,
      };
      if (scopeType !== "global") {
        if (!scopeId) {
          setError("Pick a scope target.");
          return;
        }
        body.scopeId = scopeId;
      }
      const res = await apiFetch(`/api/admin/users/${props.userId}/role-assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not assign role.");
        return;
      }
      setScopeId("");
      toast({ kind: "success", description: "Role assigned." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(assignmentId: string) {
    const ok = await confirm({
      title: "Remove this role assignment?",
      description: "The user loses the permissions granted by this assignment.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setRemoving(assignmentId);
    try {
      const result = await mutate(
        `/api/admin/users/${props.userId}/role-assignments/${assignmentId}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Could not remove assignment",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Assignment removed." });
      router.refresh();
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Role assignments ({props.assignments.length})
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          Each assignment grants a role&apos;s permissions within a scope.
        </p>
      </header>

      {props.assignments.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No role assignments yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-muted)] text-left text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Scope</th>
                <th className="px-4 py-2.5">Assigned</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {props.assignments.map((a) => (
                <tr
                  key={a.assignmentId}
                  className="border-t border-[color:var(--color-border)] transition-colors even:bg-[color:var(--color-bg-subtle)] hover:bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)]"
                >
                  <td className="px-4 py-3 align-top">
                    <span className="font-medium">{a.roleName}</span>
                    {a.isSystem ? (
                      <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.65rem] tracking-wide uppercase">
                        system
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top font-mono text-xs">{a.scopeLabel}</td>
                  <td className="px-4 py-3 align-top text-xs">
                    <LocalTime ts={a.createdAt} />
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    {props.canManage ? (
                      <button
                        type="button"
                        onClick={() => handleRemove(a.assignmentId)}
                        disabled={removing === a.assignmentId}
                        className="text-xs text-[color:var(--color-error)] hover:underline disabled:opacity-50"
                      >
                        {removing === a.assignmentId ? "Removing…" : "Remove"}
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
        <div className="space-y-3 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
          <p className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Add assignment
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectMenu
              value={roleId}
              onChange={(v) => setRoleId(v)}
              options={props.roles.map((r) => ({
                value: r.id,
                label: `${r.name}${r.isSystem ? " (system)" : ""}`,
              }))}
              ariaLabel="Role"
              className="text-sm"
            />

            <SelectMenu
              value={scopeType}
              onChange={(v) => setScopeType(v)}
              options={[
                { value: "global", label: "Global" },
                { value: "team", label: "Team" },
                { value: "server", label: "PowerDNS server" },
              ]}
              ariaLabel="Scope"
              className="text-sm"
            />

            {scopeType !== "global" ? (
              <SelectMenu
                value={scopeId}
                onChange={(v) => setScopeId(v)}
                options={scopeOptions.map((row) => ({ value: row.id, label: row.name }))}
                placeholder={`Pick a ${scopeType}…`}
                ariaLabel="Scope target"
                className="text-sm"
              />
            ) : (
              <div />
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleAssign}
              disabled={busy}
              className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {busy ? "Assigning…" : "Assign"}
            </button>
            {error ? (
              <p className="text-xs text-[color:var(--color-error)]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
