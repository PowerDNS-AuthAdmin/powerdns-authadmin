"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { KIND_SPECS, getKindSpec, isKindApiWritable } from "./kind-specs";
import { MetadataValuesInput } from "./metadata-values-input";

interface Props {
  zoneIdEncoded: string;
  serverSlug: string;
  existingKinds: readonly string[];
}

interface KindOption {
  kind: string;
  description: string;
}

const KIND_OPTIONS: KindOption[] = Object.entries(KIND_SPECS)
  .filter(([kind]) => isKindApiWritable(kind))
  .map(([kind, spec]) => ({ kind, description: spec.description }))
  .sort((a, b) => a.kind.localeCompare(b.kind));

export function AddMetadataKind({ zoneIdEncoded, serverSlug, existingKinds }: Props) {
  const router = useRouter();
  const { toast } = useDialog();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const existing = new Set(existingKinds);
  const available = KIND_OPTIONS.filter((o) => !existing.has(o.kind));
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
    <div className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
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
          <label className="mb-1 block text-xs font-medium">Kind</label>
          <KindCombobox
            value={kind}
            onChange={(next) => {
              setKind(next);
              setValues([]);
            }}
            options={available}
          />
          {spec ? (
            <p className="mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              {spec.description}
            </p>
          ) : null}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Value{listy(spec) ? "s" : ""}</label>
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
          type="button"
          onClick={handleSave}
          disabled={!kind || saving}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function listy(spec: ReturnType<typeof getKindSpec> | null): boolean {
  return spec?.type === "list";
}

interface KindComboboxProps {
  value: string | null;
  onChange: (next: string) => void;
  options: readonly KindOption[];
}

function KindCombobox({ value, onChange, options }: KindComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const filtered = options.filter(
    (o) =>
      query.trim() === "" ||
      o.kind.toLowerCase().includes(query.trim().toLowerCase()) ||
      o.description.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  function pick(kind: string) {
    onChange(kind);
    setQuery("");
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[highlight]) {
        pick(filtered[highlight].kind);
      } else {
        setOpen(true);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-left font-mono text-xs hover:border-[color:var(--color-fg-muted)]"
      >
        <span className={value ? "" : "text-[color:var(--color-fg-muted)]"}>
          {value ?? "Select a kind…"}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          className="ml-2 text-[color:var(--color-fg-muted)]"
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="absolute right-0 left-0 z-10 mt-1 overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-lg">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Filter kinds…"
            className="block w-full border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-xs outline-none"
            aria-controls={listId}
            aria-autocomplete="list"
          />
          <ul
            id={listId}
            role="listbox"
            className="max-h-60 overflow-auto py-1 text-xs"
            onMouseLeave={() => setHighlight(-1)}
          >
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-[color:var(--color-fg-muted)]">No kinds match.</li>
            ) : (
              filtered.map((o, i) => (
                <li
                  key={o.kind}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o.kind);
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
      ) : null}
    </div>
  );
}
