"use client";

/**
 * Integer-valued number input that lets the operator clear the field
 * mid-edit without it snapping back to `0` (the default behavior when
 * you back the parent state with a plain `Number()` parse). We keep a
 * local string draft so an empty field stays empty while typing; the
 * parent only sees a value when the draft parses to a valid integer
 * in range. On blur, an invalid draft reverts to the last good value.
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
}

export function NumberInput({ value, onChange, min = 0, max, disabled, className }: Props) {
  const [draft, setDraft] = useState<string>(() => String(value));
  // Tracks whether the input is currently focused. While focused, we
  // don't overwrite the operator's in-flight typing with whatever the
  // parent re-rendered with — that's how leading-zero "0" bleeds in.
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  function commit(next: string) {
    setDraft(next);
    if (next === "") return; // empty stays empty in the draft; parent untouched
    const n = Number(next);
    if (!Number.isInteger(n)) return;
    if (n < min) return;
    if (max !== undefined && n > max) return;
    onChange(n);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => commit(e.target.value)}
      onBlur={() => {
        focusedRef.current = false;
        const n = Number(draft);
        if (draft === "" || !Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
          setDraft(String(value));
        }
      }}
      className={className}
    />
  );
}
