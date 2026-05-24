"use client";

/**
 * components/ui/checkbox.tsx
 *
 * Themed checkbox — the project's replacement for the default browser checkbox.
 * A `role="checkbox"` button that fills with the accent colour + a checkmark when
 * checked, so it matches the app's design language (dark-mode aware) instead of
 * the OS control. Keyboard-operable (Space/Enter via the native button).
 */

import type { ReactNode } from "react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Accessible name when there's no visible `label`. */
  ariaLabel?: string;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
  className,
}: CheckboxProps) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 ${disabled ? "cursor-not-allowed opacity-60" : ""} ${className ?? ""}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
            : "border-[color:var(--color-border)] bg-[color:var(--color-bg)] hover:border-[color:var(--color-fg-muted)]"
        }`}
      >
        {checked ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M1.5 5l2.5 2.5L8.5 2.5"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      {label != null ? <span>{label}</span> : null}
    </label>
  );
}
