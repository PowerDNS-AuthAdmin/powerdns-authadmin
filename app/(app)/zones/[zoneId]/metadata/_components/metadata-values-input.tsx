"use client";

import { useMemo } from "react";
import { getKindSpec, isBoolTrue } from "./kind-specs";
import { Switch } from "@/components/ui/switch";
import { SelectMenu } from "@/components/ui/select-menu";

interface Props {
  kind: string;
  /** Current values (one entry per "value" PDNS stores). */
  values: readonly string[];
  onChange: (next: string[]) => void;
}

/**
 * Renders the right input control for the given metadata `kind`:
 *   bool   → "On / Off" pill toggle
 *   enum   → themed select
 *   list   → textarea (one per line) + per-line validation
 *   string → single-line text input
 *
 * Anything not in `KIND_SPECS` falls through to a textarea - covers
 * X-prefixed custom kinds and any new PDNS kinds we don't know yet.
 *
 * The controls carry the kind name as their accessible name: the visible
 * heading on the metadata page is the kind itself, and the editor rows
 * have no `<label>` of their own.
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
          ariaLabel={`${kind} value`}
        />
        <span className="font-mono text-xs">{on ? "1 (enabled)" : "0 (disabled)"}</span>
      </div>
    );
  }

  if (spec.type === "enum") {
    const current = values[0] ?? "";
    return (
      <SelectMenu
        value={current}
        options={spec.options.map((o) => ({ value: o, label: o }))}
        onChange={(next) => onChange([next])}
        placeholder="Select…"
        ariaLabel={`${kind} value`}
      />
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
        aria-label={`${kind} value`}
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
        aria-label={`${kind} values, one per line`}
        aria-invalid={lineErrors.length > 0 ? true : undefined}
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
