"use client";

/**
 * app/(app)/admin/roles/_components/role-form.tsx
 *
 * Shared form for creating and editing custom roles. Drives the
 * `/admin/roles/new` page in `mode="create"` and the `/admin/roles/[id]`
 * editable section in `mode="edit"`.
 *
 * Permissions are presented as a checkbox grid grouped by resource (the
 * first dotted segment of each permission). Each group has a "select all"
 * toggle so an operator building a wide-scope role doesn't tick 30
 * boxes by hand.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

export interface RoleFormProps {
  mode: "create" | "edit";
  /** Required in edit mode; unused in create mode. */
  roleId?: string;
  /** Required in edit mode for slug display + comparison. */
  initialSlug?: string;
  initialName?: string;
  initialDescription?: string;
  initialRequiresMfa?: boolean;
  initialPermissions?: readonly string[];
  /** The full permission vocabulary the picker renders. */
  allPermissions: readonly string[];
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export function RoleForm({
  mode,
  roleId,
  initialSlug = "",
  initialName = "",
  initialDescription = "",
  initialRequiresMfa = false,
  initialPermissions = [],
  allPermissions,
}: RoleFormProps) {
  const router = useRouter();
  const { toast } = useDialog();

  const [slug, setSlug] = useState(initialSlug);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [requiresMfa, setRequiresMfa] = useState(initialRequiresMfa);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPermissions));
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const grouped = useMemo(() => groupByResource(allPermissions), [allPermissions]);

  function togglePermission(p: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function toggleGroup(perms: readonly string[], allOn: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allOn) {
        for (const p of perms) next.delete(p);
      } else {
        for (const p of perms) next.add(p);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldErrors({});
    try {
      const url = mode === "create" ? "/api/admin/roles" : `/api/admin/roles/${roleId}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const body =
        mode === "create"
          ? {
              slug,
              name,
              description: description.trim() === "" ? undefined : description,
              requiresMfa,
              permissions: Array.from(selected),
            }
          : {
              name,
              description: description.trim() === "" ? null : description,
              requiresMfa,
              permissions: Array.from(selected),
            };
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          details?: { fieldErrors?: Record<string, string[]> };
        } | null;
        if (data?.details?.fieldErrors) setFieldErrors(data.details.fieldErrors);
        toast({
          kind: "error",
          title: mode === "create" ? "Could not create role" : "Could not save role",
          description: data?.error ?? "Unexpected error.",
        });
        return;
      }
      if (mode === "create") {
        const data = (await res.json()) as { role: { id: string } };
        toast({ kind: "success", description: "Role created." });
        router.push(`/admin/roles/${data.role.id}`);
        router.refresh();
      } else {
        toast({ kind: "success", description: "Role saved." });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const slugValid = mode === "edit" || SLUG_RE.test(slug);
  const canSubmit = slugValid && name.trim().length > 0 && selected.size > 0 && !busy;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="role-slug">
          Slug
        </label>
        <input
          id="role-slug"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={mode === "edit" || busy}
          placeholder="zone-noc"
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 font-mono text-sm disabled:bg-[color:var(--color-bg-subtle)] disabled:text-[color:var(--color-fg-muted)]"
        />
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          {mode === "edit"
            ? "Slug is the immutable lookup key — used by OIDC group mappings and any provisioning YAML referencing this role."
            : "Lowercase letters, digits, and hyphens. Starts with a letter. Cannot be changed after creation."}
        </p>
        {fieldErrors["slug"] ? (
          <p className="text-xs text-[color:var(--color-error)]">
            {fieldErrors["slug"].join("; ")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="role-name">
          Name
        </label>
        <input
          id="role-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="NOC Zone Operator"
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-sm"
        />
        {fieldErrors["name"] ? (
          <p className="text-xs text-[color:var(--color-error)]">
            {fieldErrors["name"].join("; ")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="role-description">
          Description
        </label>
        <textarea
          id="role-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          rows={2}
          placeholder="Brief summary of what this role can do."
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={requiresMfa}
            onChange={(e) => setRequiresMfa(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 cursor-pointer accent-[color:var(--color-accent)]"
          />
          <span>
            <span className="font-medium">Require MFA</span>
            <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
              Users holding this role at any scope must have TOTP enrolled before they can use the
              app.
            </span>
          </span>
        </label>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Permissions ({selected.size})
          </h2>
          {fieldErrors["permissions"] ? (
            <span className="text-xs text-[color:var(--color-error)]">
              {fieldErrors["permissions"].join("; ")}
            </span>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(grouped).map(([resource, perms]) => {
            const allOn = perms.every((p) => selected.has(p));
            const someOn = perms.some((p) => selected.has(p));
            return (
              <div
                key={resource}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                    {resource}
                  </h3>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = !allOn && someOn;
                      }}
                      onChange={() => toggleGroup(perms, allOn)}
                      disabled={busy}
                      className="h-3 w-3 cursor-pointer accent-[color:var(--color-accent)]"
                    />
                    <span>all</span>
                  </label>
                </div>
                <ul className="space-y-1">
                  {perms.map((p) => (
                    <li key={p}>
                      <label className="flex cursor-pointer items-center gap-2 font-mono text-xs">
                        <input
                          type="checkbox"
                          checked={selected.has(p)}
                          onChange={() => togglePermission(p)}
                          disabled={busy}
                          className="h-3 w-3 cursor-pointer accent-[color:var(--color-accent)]"
                        />
                        <span>{p}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex items-center justify-end gap-3 pt-4">
        <button
          type="button"
          onClick={() => router.back()}
          disabled={busy}
          className="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : mode === "create" ? "Create role" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function groupByResource(permissions: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const perm of permissions) {
    const dot = perm.indexOf(".");
    const resource = dot === -1 ? perm : perm.slice(0, dot);
    (out[resource] ??= []).push(perm);
  }
  for (const arr of Object.values(out)) arr.sort();
  return out;
}
