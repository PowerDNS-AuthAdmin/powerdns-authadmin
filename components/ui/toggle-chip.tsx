"use client";

/**
 * components/ui/toggle-chip.tsx
 *
 * A filter toggle for a status strip: a pill with a coloured dot, a label and
 * a count. `aria-pressed` carries the state, so a chip is a toggle button to
 * assistive tech, not a tab or a link. Used by the Reverse DNS and Zone
 * Monitoring pages to filter their tables by verdict and horizon.
 *
 * The contract both pages agreed on: active = filled with the status colour
 * behind a strong border, inactive = outlined and dimmed, both with a hover
 * state and a focus ring; the dot keeps its colour in both states so an
 * unselected OK still reads as green, and the count stays in the running text
 * colour so it never drops below readable contrast.
 */

import type { ReactNode } from "react";
import { Skeleton } from "./skeleton";

export type ToggleChipTone = "error" | "warn" | "success" | "muted" | "accent";

const TOGGLE_CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-bg)]";

const TOGGLE_CHIP_ACTIVE: Record<ToggleChipTone, string> = {
  error:
    "border-[color:var(--color-error)] bg-[color:var(--color-error)]/15 text-[color:var(--color-error-fg)] hover:bg-[color:var(--color-error)]/25",
  warn: "border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/15 text-[color:var(--color-warn-fg)] hover:bg-[color:var(--color-warn)]/25",
  success:
    "border-[color:var(--color-success)] bg-[color:var(--color-success)]/15 text-[color:var(--color-success-fg)] hover:bg-[color:var(--color-success)]/25",
  muted:
    "border-[color:var(--color-fg-muted)] bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]",
  accent:
    "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)]/25",
};

const TOGGLE_CHIP_INACTIVE =
  "border-[color:var(--color-border)] bg-transparent text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)]";

const CHIP_DOT_CLASS: Record<ToggleChipTone, string> = {
  error: "bg-[color:var(--color-error)]",
  warn: "bg-[color:var(--color-warn)]",
  success: "bg-[color:var(--color-success)]",
  muted: "bg-[color:var(--color-fg-muted)]",
  accent: "bg-[color:var(--color-accent)]",
};

interface ToggleChipProps {
  active: boolean;
  tone: ToggleChipTone;
  /** Tooltip explaining what the chip filters on. */
  title: string;
  onClick: () => void;
  /** Null while the count is still loading: a skeleton holds the space. */
  count: number | null;
  children: ReactNode;
}

export function ToggleChip({ active, tone, title, onClick, count, children }: ToggleChipProps) {
  // An empty bucket has nothing to call attention to: it renders neutral
  // whatever its tone or state, so only the chips with something in them light up.
  const empty = count === 0;
  const lit = active && !empty;
  const dotTone: ToggleChipTone = empty ? "muted" : tone;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`${TOGGLE_CHIP_BASE} ${lit ? TOGGLE_CHIP_ACTIVE[tone] : TOGGLE_CHIP_INACTIVE}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${CHIP_DOT_CLASS[dotTone]} ${lit ? "" : "opacity-60"}`}
      />
      {children}
      {count === null ? (
        <Skeleton className="h-3 w-4" label="Counting…" />
      ) : (
        <span className="tabular-nums">{count}</span>
      )}
    </button>
  );
}
