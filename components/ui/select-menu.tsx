"use client";

/**
 * components/ui/select-menu.tsx
 *
 * Themed single-select dropdown — the project's replacement for native `<select>`
 * (which the user dislikes on UX grounds). Visually the zone-kind chooser: a
 * button trigger + a listbox of options, each with an optional description line.
 * Closes on outside-click or Escape.
 *
 * The listbox is PORTALED to <body> with fixed positioning anchored to the
 * trigger, so it never clips inside `overflow-hidden`/scrolling containers
 * (tables, panels, modals) the way an absolutely-positioned child would. Its
 * z-index sits above the modal layer so it works inside dialogs/wizards too.
 *
 * Generic over the option value (a string union), so callers keep type safety:
 *   <SelectMenu value={algo} options={ALGORITHMS} onChange={setAlgo} />
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Secondary line under the label inside the menu (not the trigger). */
  description?: string;
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Muted text shown on the trigger when `value` matches no option (e.g. ""). */
  placeholder?: string;
  /** Accessible label when there's no visible <label> wired via htmlFor. */
  ariaLabel?: string;
  className?: string;
}

interface Anchor {
  left: number;
  width: number;
  /** Exactly one of `top` / `bottom` is set, depending on the flip direction. */
  top?: number;
  bottom?: number;
  /** Cap the listbox to the space on the chosen side so it scrolls, never clips. */
  maxHeight: number;
}

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
  className,
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Anchor the portaled listbox to the trigger. Opens downward by default, but
  // flips upward when the trigger sits near the viewport bottom (e.g. a table's
  // page-size selector, which lives in the pager at the foot of the page) so the
  // options aren't clipped off-screen. Recomputed on open and on any
  // scroll/resize so it tracks the trigger and re-flips as it moves.
  const reposition = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const GAP = 4; // breathing room between the trigger and the menu
    const EDGE = 8; // keep the menu off the very edge of the screen
    const MENU_MAX = 288; // the listbox's natural cap (the old max-h-72 = 18rem)
    const spaceBelow = window.innerHeight - b.bottom - GAP - EDGE;
    const spaceAbove = b.top - GAP - EDGE;
    // Flip up only when the menu can't get its full height below AND there's more
    // room above. Anchoring the up-menu by its BOTTOM edge means it sits directly
    // above the trigger regardless of how many options it holds — no measuring.
    const openUp = spaceBelow < MENU_MAX && spaceAbove > spaceBelow;
    if (openUp) {
      setAnchor({
        bottom: window.innerHeight - b.top + GAP,
        left: b.left,
        width: b.width,
        maxHeight: Math.max(0, Math.min(MENU_MAX, spaceAbove)),
      });
    } else {
      setAnchor({
        top: b.bottom + GAP,
        left: b.left,
        width: b.width,
        maxHeight: Math.max(0, Math.min(MENU_MAX, spaceBelow)),
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    // Capture phase so nested scroll containers also keep the menu aligned.
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  const current = options.find((o) => o.value === value);

  function toggle() {
    if (disabled) return;
    setOpen((o) => {
      if (!o) reposition(); // compute the anchor BEFORE first paint — no flash
      return !o;
    });
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        className="flex w-full items-center justify-between rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-left text-sm hover:border-[color:var(--color-fg-muted)] disabled:opacity-60"
      >
        <span className={current ? "truncate" : "truncate text-[color:var(--color-fg-muted)]"}>
          {current ? current.label : (placeholder ?? "Select…")}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 10 10"
          aria-hidden
          className="ml-2 shrink-0 opacity-60"
        >
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && anchor
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              style={{
                top: anchor.top,
                bottom: anchor.bottom,
                left: anchor.left,
                width: anchor.width,
                maxHeight: anchor.maxHeight,
              }}
              className="fixed z-[200] overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1 text-sm shadow-lg"
            >
              {options.map((o) => (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`cursor-pointer px-3 py-2 ${
                    o.value === value
                      ? "bg-[color:var(--color-bg-subtle)] font-medium"
                      : "hover:bg-[color:var(--color-bg-subtle)]"
                  }`}
                >
                  <div>{o.label}</div>
                  {o.description ? (
                    <div className="text-xs text-[color:var(--color-fg-muted)]">
                      {o.description}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
