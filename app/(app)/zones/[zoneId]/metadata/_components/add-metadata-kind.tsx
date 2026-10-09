"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { mutate } from "@/lib/client/api-fetch";
import { KIND_SPECS, getKindSpec, isKindApiWritable } from "./kind-specs";
import { MetadataValuesInput } from "./metadata-values-input";

interface Props {
  zoneIdEncoded: string;
  serverSlug: string;
  existingKinds: readonly string[];
}

const KIND_OPTIONS: Array<SelectOption<string>> = Object.entries(KIND_SPECS)
  .filter(([kind]) => isKindApiWritable(kind))
  .map(([kind, spec]) => ({ value: kind, label: kind, description: spec.description }))
  .sort((a, b) => a.value.localeCompare(b.value));

export function AddMetadataKind({ zoneIdEncoded, serverSlug, existingKinds }: Props) {
  const router = useRouter();
  const { toast } = useDialog();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const kindId = useId();

  const existing = new Set(existingKinds);
  const available = KIND_OPTIONS.filter((o) => !existing.has(o.value));
  const spec = kind ? getKindSpec(kind) : null;

  function reset() {
    setKind(null);
    setValues([]);
    setOpen(false);
  }

  async function handleSave() {
    if (!kind) return;
    setSaving(true);
    try {
      const cleaned = values.map((s) => s.trim()).filter((s) => s.length > 0);
      const result = await mutate(
        `/api/admin/pdns/zones/${zoneIdEncoded}/metadata/${encodeURIComponent(kind)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverSlug, values: cleaned }),
        },
      );
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Add failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: `Added ${kind}.` });
      reset();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
      >
        + Add metadata kind
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
      className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Add metadata kind</h3>
        <button
          type="button"
          onClick={reset}
          className="text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          Cancel
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={kindId} className="mb-1 block text-xs font-medium">
            Kind
          </label>
          <SelectMenu
            id={kindId}
            value={kind ?? ""}
            onChange={(next) => {
              setKind(next);
              setValues([]);
            }}
            options={available}
            placeholder="Select a kind…"
            searchable
            searchPlaceholder="Filter kinds…"
          />
          {spec ? (
            <p className="mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              {spec.description}
            </p>
          ) : null}
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">Value{listy(spec) ? "s" : ""}</span>
          {kind ? (
            <MetadataValuesInput kind={kind} values={values} onChange={setValues} />
          ) : (
            <p className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              Pick a kind first.
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!kind || saving}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

function listy(spec: ReturnType<typeof getKindSpec> | null): boolean {
  return spec?.type === "list";
}
