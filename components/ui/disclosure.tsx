"use client";

/**
 * Disclosure — the one collapsible "summary" affordance used across the app
 * (audit-log before/after diffs, the PowerDNS HTTP-request logs, …) so every
 * expand/collapse reads the same: a rotating ▸/▾ marker, an accent label, and
 * an optional trailing accessory (e.g. a "N failed" badge).
 *
 * Built on native `<details>` so it works without JS, but we mirror `open` into
 * React state to flip the marker. Callers control padding + font-size via the
 * `summaryClassName` / `bodyClassName` slots; the shared look lives here.
 */

import { useState, type ReactNode } from "react";

interface DisclosureProps {
  /** The clickable summary label. */
  label: ReactNode;
  /** Optional content shown after the label on the summary line (badges, counts). */
  accessory?: ReactNode;
  /** Revealed when open. */
  children: ReactNode;
  /** Extra classes on the `<details>` wrapper. */
  className?: string;
  /** Extra classes on the clickable `<summary>` line. */
  summaryClassName?: string;
  /** Extra classes on the revealed body wrapper. */
  bodyClassName?: string;
  defaultOpen?: boolean;
}

export function Disclosure({
  label,
  accessory,
  children,
  className,
  summaryClassName,
  bodyClassName,
  defaultOpen = false,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={className}>
      <summary
        className={[
          "flex cursor-pointer list-none items-center gap-1.5 text-[color:var(--color-accent)] hover:underline",
          summaryClassName ?? "",
        ].join(" ")}
      >
        <span aria-hidden className="opacity-70 select-none">
          {open ? "▾" : "▸"}
        </span>
        <span>{label}</span>
        {accessory}
      </summary>
      <div className={bodyClassName}>{children}</div>
    </details>
  );
}
