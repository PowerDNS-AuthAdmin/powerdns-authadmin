"use client";

/**
 * components/ui/switch.tsx
 *
 * Themed on/off toggle (`role="switch"`) - the project's standard boolean
 * control, replacing the three hand-rolled copies of the same 11×6 pill. Pair it
 * with a separate text label/state span at the call site.
 */

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name when there's no associated visible label. */
  ariaLabel?: string;
  className?: string;
}

export function Switch({ checked, onChange, disabled, ariaLabel, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-[color:var(--color-accent)]" : "bg-[color:var(--color-bg-muted)]"
      } ${className ?? ""}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
