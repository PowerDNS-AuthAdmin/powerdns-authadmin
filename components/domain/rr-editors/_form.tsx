/**
 * components/domain/rr-editors/_form.tsx
 *
 * Tiny shared form primitives used by every per-type editor. Mirrors the
 * `Field` + `inputClass` defined locally in `editable-record-table.tsx`
 * so the visual rhythm stays identical when the structured editors slot
 * into that dialog.
 */

"use client";

import type { ReactNode } from "react";

export const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{hint}</p> : null}
    </div>
  );
}

/**
 * Clamp a string to a non-negative integer ≤ max. Returns `null` for empty
 * input so an editor can render the empty state without forcing a 0.
 */
export function parseUintClamped(raw: string, max: number): number | null {
  if (raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

export function uintInput(
  current: number,
  max: number,
  onChange: (n: number) => void,
  extra: { placeholder?: string; ariaLabel?: string } = {},
) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      value={current}
      placeholder={extra.placeholder}
      aria-label={extra.ariaLabel}
      onChange={(e) => {
        const n = parseUintClamped(e.target.value, max);
        onChange(n ?? 0);
      }}
      className={inputClass}
    />
  );
}
