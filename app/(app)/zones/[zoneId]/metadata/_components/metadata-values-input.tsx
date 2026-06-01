"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getKindSpec, isBoolTrue } from "./kind-specs";
import { Switch } from "@/components/ui/switch";

interface Props {
  kind: string;
  /** Current values (one entry per "value" PDNS stores). */
  values: readonly string[];
  onChange: (next: string[]) => void;
}

/**
 * Renders the right input control for the given metadata `kind`:
 *   bool   → "On / Off" pill toggle
 *   enum   → React-style dropdown
 *   list   → textarea (one per line) + per-line validation
 *   string → single-line text input
 *
 * Anything not in `KIND_SPECS` falls through to a textarea - covers
 * X-prefixed custom kinds and any new PDNS kinds we don't know yet.
 */
export function MetadataValuesInput({ kind, values, onChange }: Props) {
  const spec = getKindSpec(kind);

  if (spec.type === "bool") {
    const current = values[0] ?? "";
    const on = isBoolTrue(current);
    return (
      <div className="flex items-center gap-2">
        <Switch
          checked={on}
          onChange={(next) => onChange([next ? "1" : "0"])}
          ariaLabel="Toggle value"
        />
        <span className="font-mono text-xs">{on ? "1 (enabled)" : "0 (disabled)"}</span>
      </div>
    );
  }

  if (spec.type === "enum") {
    const current = values[0] ?? "";
    return (
      <EnumSelect value={current} options={spec.options} onChange={(next) => onChange([next])} />
    );
  }

  if (spec.type === "string") {
    const current = values[0] ?? "";
    return (
      <input
        type="text"
        value={current}
        onChange={(e) => onChange(e.target.value.trim() === "" ? [] : [e.target.value])}
        placeholder="Single value"
        className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-2 font-mono text-xs"
      />
    );
  }

  return <ListTextarea kind={kind} values={values} onChange={onChange} />;
}

function ListTextarea({ kind, values, onChange }: Props) {
  const spec = getKindSpec(kind);
  const lineHint = spec.type === "list" ? spec.lineHint : undefined;
  const validate = spec.type === "list" ? spec.validate : undefined;
  const text = useMemo(() => values.join("\n"), [values]);

  const lineErrors = useMemo(() => {
    if (!validate) return [];
    return text
      .split(/\r?\n/)
      .map((line, idx) => {
        const trimmed = line.trim();
        if (trimmed === "") return null;
        const err = validate(trimmed);
        return err ? { line: idx + 1, error: err, value: trimmed } : null;
      })
      .filter((x): x is { line: number; error: string; value: string } => x !== null);
  }, [text, validate]);

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value.split(/\r?\n/))}
        rows={Math.max(2, text.split(/\r?\n/).length + 1)}
        placeholder={lineHint ? `One value per line, e.g. ${lineHint}` : "One value per line"}
        className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-2 font-mono text-xs"
      />
      {lineErrors.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[0.6875rem] text-[color:var(--color-error)]">
          {lineErrors.map((e) => (
            <li key={e.line}>
              Line {e.line} (<code className="font-mono">{e.value}</code>): {e.error}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface EnumSelectProps {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
}

function EnumSelect({ value, options, onChange }: EnumSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-left font-mono text-xs hover:border-[color:var(--color-fg-muted)]"
      >
        <span className={value ? "" : "text-[color:var(--color-fg-muted)]"}>
          {value || "Select…"}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="ml-2 opacity-60">
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-10 mt-1 max-h-60 overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1 text-xs shadow-lg"
        >
          {options.map((o) => (
            <li
              key={o}
              role="option"
              aria-selected={o === value}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o);
                setOpen(false);
              }}
              className={`cursor-pointer px-2 py-1.5 font-mono ${
                o === value
                  ? "bg-[color:var(--color-bg-subtle)] font-medium"
                  : "hover:bg-[color:var(--color-bg-subtle)]"
              }`}
            >
              {o}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
