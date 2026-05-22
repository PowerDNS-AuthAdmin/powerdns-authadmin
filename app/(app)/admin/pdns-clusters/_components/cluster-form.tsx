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

export interface ClusterFormProps {
  mode: "create" | "edit";
  clusterId?: string;
  initialSlug?: string;
  initialName?: string;
  initialDescription?: string;
  initialWriteStrategy?: Strategy;
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export function ClusterForm({
  mode,
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
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

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
              writeStrategy,
            }
          : {
              name,
              description: description.trim() === "" ? null : description,
              writeStrategy,
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
          title: mode === "create" ? "Could not create cluster" : "Could not save cluster",
          description: data?.error ?? "Unexpected error.",
        });
        return;
      }
      if (mode === "create") {
        const data = (await res.json()) as { cluster: { id: string } };
        toast({ kind: "success", description: "Cluster created." });
        router.push(`/admin/pdns-clusters/${data.cluster.id}`);
        router.refresh();
      } else {
        toast({ kind: "success", description: "Cluster saved." });
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

      <div className="space-y-2">
        <label className="block text-sm font-medium">Peer selection strategy</label>
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
          {busy ? "Saving…" : mode === "create" ? "Create cluster" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
