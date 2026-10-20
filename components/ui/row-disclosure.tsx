"use client";

/**
 * components/ui/row-disclosure.tsx
 *
 * Row-detail accordion for tables: a chevron in front of a row's first value
 * that reveals a detail panel beneath the row, one open row per table. Built
 * for `<DataTable renderRowDetail>` (Reverse DNS, Zone Monitoring) but the
 * pieces are table-agnostic so any row list can adopt the same affordance.
 *
 *   const details = useRowDisclosure();
 *   …
 *   <DisclosureChevron
 *     open={details.isOpen(row.id)}
 *     onToggle={() => details.toggle(row.id)}
 *     label={row.ip}
 *     controls={rowDetailId(panelPrefix, row.id)}
 *   />
 *   …
 *   renderRowDetail={(row) =>
 *     details.isOpen(row.id) ? (
 *       <RowDisclosurePanel id={rowDetailId(panelPrefix, row.id)} label={`Details for ${row.ip}`}>
 *         …
 *       </RowDisclosurePanel>
 *     ) : null
 *   }
 *
 * Why mutually exclusive: these panels are tall (findings, observations, a
 * definitions grid). Two open at once pushes the rows the operator is
 * comparing off screen; one open row keeps the table scannable and matches
 * what the change-log viewer already does. The open id is the row's stable id,
 * so a re-fetch that rebuilds the rows keeps the same row open.
 */

import { ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

export interface RowDisclosure {
  /** The id of the open row, or null when every row is collapsed. */
  openId: string | null;
  /** Open `id`, or collapse it when it is the open one. Opening closes any other row. */
  toggle: (id: string) => void;
  isOpen: (id: string) => boolean;
  close: () => void;
}

/** One-open-row disclosure state, keyed by a stable row id. */
export function useRowDisclosure(): RowDisclosure {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
  }, []);
  const isOpen = useCallback((id: string) => openId === id, [openId]);
  const close = useCallback(() => setOpenId(null), []);
  return useMemo(() => ({ openId, toggle, isOpen, close }), [openId, toggle, isOpen, close]);
}

/**
 * DOM id for a row's detail panel, shared by the chevron's `aria-controls`
 * and the panel. `prefix` keeps two tables on one page apart (pass a
 * `useId()` value); the row id may contain dots, colons or pipes, which are
 * valid in an HTML id, but never whitespace, which is not.
 */
export function rowDetailId(prefix: string, rowId: string): string {
  return `${prefix}detail-${rowId.replace(/\s+/g, "-")}`;
}

interface DisclosureChevronProps {
  open: boolean;
  onToggle: () => void;
  /** What the row is about, for the accessible name: "Show details for <label>". */
  label: string;
  /** The detail panel's DOM id (see `rowDetailId`). */
  controls: string;
  disabled?: boolean;
  className?: string;
}

/**
 * `data-*` markers a caller may put on the chevron, e.g. the hook the
 * screenshot runner uses to find the change-log toggle among the page's
 * other `aria-expanded` controls.
 */
type DataAttributes = Record<`data-${string}`, string | undefined>;

/**
 * The chevron toggle. Rotates a quarter turn when open; the rotation is a
 * CSS transition that `motion-reduce` disables, so a reduced-motion user
 * sees the state change without the animation.
 */
export function DisclosureChevron({
  open,
  onToggle,
  label,
  controls,
  disabled = false,
  className = "",
  ...dataAttributes
}: DisclosureChevronProps & DataAttributes) {
  return (
    <button
      {...dataAttributes}
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? "Hide" : "Show"} details for ${label}`}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[color:var(--color-fg-muted)] transition-colors hover:bg-[color:var(--color-bg-muted)] hover:text-[color:var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <ChevronRight
        aria-hidden
        className={`h-4 w-4 transition-transform duration-150 motion-reduce:transition-none ${
          open ? "rotate-90" : ""
        }`}
      />
    </button>
  );
}

interface RowDisclosurePanelProps {
  /** Must equal the chevron's `controls`. */
  id: string;
  /** Accessible name of the region, e.g. "Details for 192.0.2.1". */
  label: string;
  children: ReactNode;
  className?: string;
}

/** The revealed panel: a labelled region so a screen reader can jump to it from the chevron. */
export function RowDisclosurePanel({ id, label, children, className }: RowDisclosurePanelProps) {
  return (
    <div id={id} role="region" aria-label={label} className={className}>
      {children}
    </div>
  );
}
