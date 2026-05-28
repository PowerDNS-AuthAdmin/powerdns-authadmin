"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

const STRATEGIES = [
  {
    value: "round_robin",
    label: "Round-robin",
    hint: "Rotate evenly across active peers. Cheapest; no DB read per write.",
  },
  {
    value: "lowest_latency",
    label: "Lowest latency",
    hint: "Pick the peer with the lowest recent p50 latency from pdns_server_stats.",
  },
  { value: "random", label: "Random", hint: "Uniform random pick." },
  {
    value: "least_load",
    label: "Least load",
    hint: "Pick the peer with the fewest recent zone-count samples.",
  },
] as const;

type Strategy = (typeof STRATEGIES)[number]["value"];

/** A backend offered as an initial group member on the create form. */
export interface AssignableServer {
  id: string;
  name: string;
  slug: string;
  /** Short capability summary, e.g. "primary" or "primary + secondary". */
  role: string;
}

export interface ClusterFormProps {
  mode: "create" | "edit";
  /**
   * Show the peer-selection strategy. Only meaningful for a multi-primary
   * cluster (≥2 writable peers); hidden for a primary+secondaries group, which
   * has a single write target (ADR-0014). Defaults off — the create form has no
   * members yet, so it can't be a multi-primary cluster.
   */
  showStrategy?: boolean;
  /**
   * Ungrouped backends the operator can add as initial members (create mode).
   * Omitted/empty hides the picker.
   */
  assignableServers?: AssignableServer[];
  clusterId?: string;
  initialSlug?: string;
  initialName?: string;
  initialDescription?: string;
  initialWriteStrategy?: Strategy;
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export function ClusterForm({
  mode,
  showStrategy = false,
  assignableServers = [],
  clusterId,
  initialSlug = "",
  initialName = "",
  initialDescription = "",
  initialWriteStrategy = "round_robin",
}: ClusterFormProps) {
  const router = useRouter();
  const { toast } = useDialog();
  const [slug, setSlug] = useState(initialSlug);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [writeStrategy, setWriteStrategy] = useState<Strategy>(initialWriteStrategy);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const showMemberPicker = mode === "create" && assignableServers.length > 0;

  function toggleMember(id: string) {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldErrors({});
    try {
      const url =
        mode === "create" ? "/api/admin/pdns/clusters" : `/api/admin/pdns/clusters/${clusterId}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const body =
        mode === "create"
          ? {
              slug,
              name,
              description: description.trim() === "" ? undefined : description,
              // Only send the strategy when it's surfaced (multi-primary).
              // Otherwise let the server default / preserve it.
              ...(showStrategy ? { writeStrategy } : {}),
              ...(selectedMembers.size > 0 ? { memberServerIds: [...selectedMembers] } : {}),
            }
          : {
              name,
              description: description.trim() === "" ? null : description,
              ...(showStrategy ? { writeStrategy } : {}),
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
          title: mode === "create" ? "Could not create group" : "Could not save group",
          description: data?.error ?? "Unexpected error.",
        });
        return;
      }
      if (mode === "create") {
        const data = (await res.json()) as { cluster: { id: string } };
        toast({ kind: "success", description: "Group created." });
        router.push(`/admin/clusters/${data.cluster.id}`);
        router.refresh();
      } else {
        toast({ kind: "success", description: "Group saved." });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const slugValid = mode === "edit" || SLUG_RE.test(slug);
  const canSubmit = slugValid && name.trim().length > 0 && !busy;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="cluster-slug">
          Slug
        </label>
        <input
          id="cluster-slug"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={mode === "edit" || busy}
          placeholder="prod"
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 font-mono text-sm disabled:bg-[color:var(--color-bg-subtle)] disabled:text-[color:var(--color-fg-muted)]"
        />
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          {mode === "edit"
            ? "Slug is immutable; provisioning YAML cluster_slug references rely on this value."
            : "Lowercase letters, digits, and hyphens. Starts with a letter."}
        </p>
        {fieldErrors["slug"] ? (
          <p className="text-xs text-[color:var(--color-error)]">
            {fieldErrors["slug"].join("; ")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="cluster-name">
          Name
        </label>
        <input
          id="cluster-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="Production cluster"
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-sm"
        />
        {fieldErrors["name"] ? (
          <p className="text-xs text-[color:var(--color-error)]">
            {fieldErrors["name"].join("; ")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="cluster-description">
          Description
        </label>
        <textarea
          id="cluster-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          rows={2}
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-sm"
        />
      </div>

      {showStrategy ? (
        <div className="space-y-2">
          <label className="block text-sm font-medium">Peer selection strategy</label>
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            How the app picks which writable peer to route a read/write through. Only applies to
            multi-primary clusters (≥2 writable peers).
          </p>
          <div className="space-y-2">
            {STRATEGIES.map((s) => (
              <label
                key={s.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-sm"
              >
                <input
                  type="radio"
                  name="write-strategy"
                  value={s.value}
                  checked={writeStrategy === s.value}
                  onChange={() => setWriteStrategy(s.value)}
                  disabled={busy}
                  className="mt-0.5 cursor-pointer accent-[color:var(--color-accent)]"
                />
                <span>
                  <span className="font-medium">{s.label}</span>
                  <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
                    {s.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {showMemberPicker ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium">Members</label>
            <span className="text-xs text-[color:var(--color-fg-muted)]">
              {selectedMembers.size} selected
            </span>
          </div>
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            Add ungrouped backends now, or assign them later from each server&rsquo;s page. Only
            servers that don&rsquo;t already belong to a group are listed.
          </p>
          <ServerMultiSelect
            servers={assignableServers}
            selected={selectedMembers}
            onToggle={toggleMember}
            onSelectAll={() => setSelectedMembers(new Set(assignableServers.map((s) => s.id)))}
            onClear={() => setSelectedMembers(new Set())}
            disabled={busy}
          />
          {fieldErrors["memberServerIds"] ? (
            <p className="text-xs text-[color:var(--color-error)]">
              {fieldErrors["memberServerIds"].join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}

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
          {busy ? "Saving…" : mode === "create" ? "Create group" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

interface ServerMultiSelectProps {
  servers: AssignableServer[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  disabled?: boolean;
}

/**
 * Themed multi-select list of backends — clickable rows with a custom check
 * indicator (no native checkbox, per the project's form-control conventions).
 * The whole row is the hit target; select-all / clear live in the header.
 */
function ServerMultiSelect({
  servers,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  disabled,
}: ServerMultiSelectProps) {
  const allSelected = selected.size === servers.length && servers.length > 0;
  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-1.5 text-xs text-[color:var(--color-fg-muted)]">
        <span>
          {servers.length} ungrouped server{servers.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={allSelected ? onClear : onSelectAll}
          disabled={disabled}
          className="text-[color:var(--color-accent)] hover:underline disabled:opacity-50"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>
      <ul className="max-h-64 divide-y divide-[color:var(--color-border)] overflow-auto">
        {servers.map((s) => {
          const isSelected = selected.has(s.id);
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onToggle(s.id)}
                disabled={disabled}
                aria-pressed={isSelected}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                  isSelected
                    ? "bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)]"
                    : "hover:bg-[color:var(--color-bg-subtle)]"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[0.625rem] ${
                    isSelected
                      ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
                      : "border-[color:var(--color-border)] bg-[color:var(--color-bg)]"
                  }`}
                >
                  {isSelected ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
                    <code className="font-mono">{s.slug}</code>
                    <span className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-1.5 py-0.5 text-[0.625rem] tracking-wide uppercase">
                      {s.role}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
