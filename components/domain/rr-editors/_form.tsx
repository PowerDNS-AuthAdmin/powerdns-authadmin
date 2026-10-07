/**
 * components/domain/rr-editors/_form.tsx
 *
 * Tiny shared form primitives used by every per-type editor. Mirrors the
 * `Field` + `inputClass` defined locally in `editable-record-table.tsx`
 * so the visual rhythm stays identical when the structured editors slot
 * into that dialog.
 */

"use client";

import { cloneElement, isValidElement, useId, type ReactNode } from "react";
import { NumberInput } from "@/components/ui/number-input";

export const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]";

/**
 * Label + control + hint. When the child is a single element without an
 * `id`, the label is wired to it with `htmlFor` so clicking the label
 * focuses the control and screen readers announce it - the structured
 * editors render bare inputs, so this is where their labels get attached.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const hintId = `${autoId}-hint`;
  let control = children;
  let controlId: string | undefined;
  if (isValidElement<{ id?: string; "aria-describedby"?: string }>(children)) {
    controlId = children.props.id ?? autoId;
    control = cloneElement(children, {
      id: controlId,
      ...(hint && !children.props["aria-describedby"] ? { "aria-describedby": hintId } : {}),
    });
  }
  return (
    <div>
      <label htmlFor={controlId} className="block text-xs font-medium">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          {hint}
        </p>
      ) : null}
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

/**
 * Unsigned-integer field. Backed by `<NumberInput>` so the operator can
 * clear the field while retyping (a controlled `value={number}` snaps an
 * emptied field straight back to `0`, which made "select all, type 20"
 * produce "020"-style surprises in the MX / SRV editors).
 */
export function uintInput(
  current: number,
  max: number,
  onChange: (n: number) => void,
  extra: { placeholder?: string; ariaLabel?: string } = {},
) {
  return (
    <NumberInput
      value={current}
      min={0}
      max={max}
      onChange={onChange}
      placeholder={extra.placeholder}
      ariaLabel={extra.ariaLabel}
      className={inputClass}
    />
  );
}
