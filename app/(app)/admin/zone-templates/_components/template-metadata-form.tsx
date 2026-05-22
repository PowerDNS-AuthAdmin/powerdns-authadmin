"use client";

/**
 * Per-template Metadata editor. Stores a `{kind: values[]}` bag on the
 * template that the zone-create apply path replays via PDNS' metadata
 * endpoints. UX matches the zone metadata tab — same KIND_SPECS, same
 * MetadataValuesInput renderer, same kind picker — so an operator who
 * knows the zone metadata page reads this without retraining.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import {
  KIND_SPECS,
  ZONE_OBJECT_KINDS,
  getKindSpec,
  isKindApiWritable,
} from "@/app/(app)/zones/[zoneId]/metadata/_components/kind-specs";
import { MetadataValuesInput } from "@/app/(app)/zones/[zoneId]/metadata/_components/metadata-values-input";

interface Props {
  templateId: string;
  initial: Record<string, string[]>;
  canEdit: boolean;
}

type Bag = Record<string, string[]>;

interface KindOption {
  kind: string;
  description: string;
}

const KIND_OPTIONS: KindOption[] = Object.entries(KIND_SPECS)
  .filter(([k]) => isKindApiWritable(k) && !ZONE_OBJECT_KINDS.has(k))
  .map(([k, s]) => ({ kind: k, description: s.description }))
  .sort((a, b) => a.kind.localeCompare(b.kind));

export function TemplateMetadataForm({ templateId, initial, canEdit }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [bag, setBag] = useState<Bag>(() => structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const dirty = JSON.stringify(bag) !== JSON.stringify(initial);
  const sortedKinds = Object.keys(bag).sort();

  function update(kind: string, values: string[]) {
    setBag((prev) => ({ ...prev, [kind]: values }));
  }

  async function handleDelete(kind: string) {
    const ok = await confirm({
      title: `Remove ${kind}?`,
      description: `The kind will be dropped from the template's default metadata. Zones already created from the template are not affected.`,
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setBag((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Strip empty-value entries on save so an operator clearing a row
      // also removes the kind. Empty values would round-trip and look
      // identical to "no kind set" anyway.
      const cleaned: Bag = {};
      for (const [k, vs] of Object.entries(bag)) {
        const trimmed = vs.map((v) => v.trim()).filter((v) => v.length > 0);
        if (trimmed.length > 0) cleaned[k] = trimmed;
      }
      const result = await mutate(`/api/admin/zone-templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: cleaned }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Save failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Template metadata saved." });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function addKind(kind: string) {
    setBag((prev) => ({ ...prev, [kind]: prev[kind] ?? [] }));
    setAdding(false);
  }

  const availableToAdd = KIND_OPTIONS.filter((o) => !(o.kind in bag));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Metadata kinds applied as defaults when a zone is created from this template.
        </p>
        {canEdit && !adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={availableToAdd.length === 0}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            + Add metadata kind
          </button>
        ) : null}
      </div>

      {adding ? (
        <KindPicker options={availableToAdd} onPick={addKind} onCancel={() => setAdding(false)} />
      ) : null}

      {sortedKinds.length === 0 ? (
        <div className="rounded border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4 text-center text-xs text-[color:var(--color-fg-muted)]">
          No metadata defaults yet. Add a kind above to seed it on every zone created from this
          template.
        </div>
      ) : (
        <ul className="space-y-3">
          {sortedKinds.map((kind) => {
            const spec = getKindSpec(kind);
            return (
              <li
                key={kind}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h3 className="font-mono text-sm font-medium">{kind}</h3>
                    <p className="mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]">
                      {spec.description}
                    </p>
                  </div>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(kind)}
                      className="text-[0.6875rem] text-[color:var(--color-error)] hover:underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </header>
                <div className="mt-3">
                  <MetadataValuesInput
                    kind={kind}
                    values={bag[kind] ?? []}
                    onChange={(next) => update(kind, next)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save metadata"}
          </button>
          {!dirty ? (
            <span className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              No unsaved changes
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function KindPicker({
  options,
  onPick,
  onCancel,
}: {
  options: KindOption[];
  onPick: (kind: string) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        onCancel();
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onCancel]);

  const filtered = options.filter(
    (o) =>
      query.trim() === "" ||
      o.kind.toLowerCase().includes(query.trim().toLowerCase()) ||
      o.description.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-sm"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[highlight]) onPick(filtered[highlight].kind);
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        placeholder="Filter kinds…"
        className="block w-full border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-xs outline-none"
        aria-controls={listId}
      />
      <ul id={listId} className="max-h-60 overflow-auto py-1 text-xs">
        {filtered.length === 0 ? (
          <li className="px-2 py-2 text-[color:var(--color-fg-muted)]">No kinds match.</li>
        ) : (
          filtered.map((o, i) => (
            <li
              key={o.kind}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o.kind);
              }}
              className={`cursor-pointer px-2 py-1.5 ${
                i === highlight
                  ? "bg-[color:var(--color-bg-subtle)]"
                  : "hover:bg-[color:var(--color-bg-subtle)]"
              }`}
            >
              <div className="font-mono">{o.kind}</div>
              <div className="text-[0.625rem] text-[color:var(--color-fg-muted)]">
                {o.description}
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
