"use client";

/**
 * components/ui/datetime-picker.tsx
 *
 * Thin wrapper around react-datepicker that takes + returns ISO
 * strings. Keeps the on-the-wire format unambiguous (UTC ISO) while
 * the picker itself renders in the BROWSER's local timezone — same
 * shape every filter form uses.
 *
 * On a fresh date click that lands at midnight, snap to start-of-day
 * (`side="from"`) or end-of-day (`side="to"`) so a single date
 * selection produces a useful range filter without the operator
 * having to scrub through the time column. If the operator picked a
 * specific time the snap is skipped — their explicit choice wins.
 *
 * Used by every datetime filter input across the admin surface so the
 * UX is consistent: zone change log, audit log, PDNS request log,
 * API token expiry.
 */

import DatePicker from "react-datepicker";
// react-datepicker's stylesheet is imported once at the top of
// `app/globals.css` so our dark-mode overrides land later in the
// cascade. Importing it here would re-order the bundle and the
// library's hardcoded light colors would win.

export interface DateTimePickerProps {
  /** Current value as an ISO string (UTC). Empty/null = unset. */
  value: string;
  /** Called with the next ISO string, or empty string when cleared. */
  onChange: (iso: string) => void;
  /**
   * Boundary semantic — controls the start/end-of-day snap on a
   * fresh date click. `"point"` skips the snap (used for the API-
   * token expiry field where there's no natural side).
   */
  side?: "from" | "to" | "point";
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  /** Optional minimum date constraint (e.g. "now" for an expiry). */
  minDate?: Date;
}

export function DateTimePicker({
  value,
  onChange,
  side = "point",
  placeholder = "Any time",
  className,
  disabled,
  id,
  minDate,
}: DateTimePickerProps) {
  return (
    <DatePicker
      id={id}
      selected={isoToLocalDate(value)}
      onChange={(d: Date | null) => {
        if (!d) {
          onChange("");
          return;
        }
        const snapped = side === "point" ? d : snapBoundary(d, side);
        onChange(snapped.toISOString());
      }}
      showTimeSelect
      timeFormat="HH:mm"
      timeIntervals={15}
      dateFormat="dd MMM yyyy h:mm aa"
      placeholderText={placeholder}
      isClearable
      disabled={disabled}
      {...(minDate ? { minDate } : {})}
      className={
        className ??
        "block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
      }
      wrapperClassName="!block w-full"
      popperPlacement="bottom-start"
    />
  );
}

/** ISO → Date in the local zone. Returns null when the input is
 *  empty or malformed so the picker shows its placeholder. */
function isoToLocalDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Snap to start-of-day (`from`) or end-of-day (`to`) when the time
 *  is at exact midnight — i.e. the operator clicked a date in the
 *  calendar without touching the time column. Any explicit time
 *  choice survives untouched. */
function snapBoundary(d: Date, side: "from" | "to"): Date {
  const untouched = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  if (!untouched) return d;
  const out = new Date(d);
  if (side === "from") out.setHours(0, 0, 0, 0);
  else out.setHours(23, 59, 59, 999);
  return out;
}
