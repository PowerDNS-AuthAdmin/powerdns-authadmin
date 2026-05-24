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
  top: number;
  left: number;
  width: number;
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

  // Anchor the portaled listbox to the trigger. Recomputed on open and on any
  // scroll/resize so it tracks the trigger instead of drifting.
  const reposition = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setAnchor({ top: b.bottom + 4, left: b.left, width: b.width });
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
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              className="fixed z-[200] max-h-72 overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1 text-sm shadow-lg"
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
