"use client";

/**
 * app/(app)/admin/_components/zone-grants-panel.tsx
 *
 * Per-principal zone-grant management. Renders the same surface for
 * both user principals (admin /admin/users/[id]) and team principals
 * (admin /admin/teams/[id]) — the only differences are which API
 * endpoint to call, the empty-state copy, and the "what does this
 * grant do?" wording.
 *
 * Permission vocab is passed in from the server component so the
 * `lib/rbac/permissions` import boundary isn't crossed by a client file.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu } from "@/components/ui/select-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { mutate } from "@/lib/client/api-fetch";

interface Grant {
  id: string;
  serverId: string;
  serverName: string;
  zoneName: string;
  permissions: string[];
}

interface ServerOption {
  id: string;
  name: string;
}

interface Props {
  /** Where to POST/GET/DELETE — e.g. `/api/admin/users/<id>/zone-grants`. */
  endpointBase: string;
  /** "user" → "the user immediately loses…"; "team" → "every member of this team immediately loses…". */
  principalKind: "user" | "team";
  canManage: boolean;
  grants: Grant[];
  servers: ServerOption[];
  /** Subset of the master vocabulary appropriate for zone grants. */
  permissionVocab: readonly string[];
}

export function ZoneGrantsPanel({
  endpointBase,
  principalKind,
  canManage,
  grants,
  servers,
  permissionVocab,
}: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [open, setOpen] = useState(false);
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [zoneName, setZoneName] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const principalLabel = principalKind === "team" ? "team" : "user";

  function togglePerm(p: string) {
    const next = new Set(selectedPerms);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelectedPerms(next);
  }

  function reset() {
    setOpen(false);
    setZoneName("");
    setSelectedPerms(new Set());
  }

  async function handleAdd() {
    if (!serverId) {
      toast({ kind: "error", description: "Pick a server." });
      return;
    }
    if (!zoneName.trim()) {
      toast({ kind: "error", description: "Enter a zone name." });
      return;
    }
    setAdding(true);
    try {
      const result = await mutate(endpointBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId,
          zoneName: zoneName.trim(),
          permissions: Array.from(selectedPerms),
        }),
      });
      if (!result.ok) {
        toast({ kind: "error", title: "Grant failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: "Grant added." });
      reset();
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(g: Grant) {
    const description =
      principalKind === "team"
        ? `Every member of this team immediately loses these per-zone permissions on ${g.serverName}. Direct user grants and role-derived permissions are unaffected.`
        : `The ${principalLabel} immediately loses these per-zone permissions on ${g.serverName}. Permissions inherited from team / role assignments are unaffected.`;
    const ok = await confirm({
      title: `Revoke grant on ${g.zoneName}?`,
      description,
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    setRemovingId(g.id);
    try {
      const result = await mutate(`${endpointBase}/${encodeURIComponent(g.id)}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toast({ kind: "error", title: "Revoke failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: "Grant revoked." });
      router.refresh();
    } finally {
      setRemovingId(null);
    }
  }

  const emptyMessage =
    principalKind === "team"
      ? "No per-zone grants on this team. Members' effective zone permissions come from role assignments and direct user grants only."
      : "No per-zone grants. The user's effective permissions on zones come from role assignments and team grants only.";

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Zone grants
        </h2>
        {canManage ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
          >
            {open ? "Cancel" : "Add grant"}
          </button>
        ) : null}
      </header>

      {grants.length === 0 ? (
        <p className="text-xs text-[color:var(--color-fg-muted)]">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li
              key={g.id}
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs">{g.zoneName}</div>
                  <div className="text-xs text-[color:var(--color-fg-muted)]">
                    on <code>{g.serverName}</code>
                  </div>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => handleRemove(g)}
                    disabled={removingId === g.id}
                    className="shrink-0 rounded border border-[color:var(--color-error)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                  >
                    {removingId === g.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </div>
              {g.permissions.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {g.permissions.map((p) => (
                    <span
                      key={p}
                      className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.625rem]"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[color:var(--color-fg-muted)] italic">
                  No permissions selected. The grant exists but authorizes nothing.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && canManage ? (
        <div className="mt-4 space-y-3 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr] sm:items-end">
            <div>
              <label htmlFor="zg-server" className="block text-xs font-medium">
                Server
              </label>
              <SelectMenu
                value={serverId}
                onChange={(v) => setServerId(v)}
                options={servers.map((s) => ({ value: s.id, label: s.name }))}
                ariaLabel="Server"
                className="mt-1 w-full text-sm"
              />
            </div>
            <div>
              <label htmlFor="zg-zone" className="block text-xs font-medium">
                Zone name
              </label>
              <input
                id="zg-zone"
                type="text"
                value={zoneName}
                onChange={(e) => setZoneName(e.target.value)}
                placeholder="example.com"
                className="mt-1 w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-sm"
              />
            </div>
          </div>
          <fieldset>
            <legend className="text-xs font-medium">Permissions</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {permissionVocab.map((p) => (
                <Checkbox
                  key={p}
                  checked={selectedPerms.has(p)}
                  onChange={() => togglePerm(p)}
                  label={<code className="font-mono text-xs leading-none">{p}</code>}
                />
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={adding}
              className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {adding ? "Granting…" : "Grant"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
