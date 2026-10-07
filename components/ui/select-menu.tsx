"use client";

/**
 * components/ui/select-menu.tsx
 *
 * Themed single-select dropdown - the project's replacement for native `<select>`
 * (which the user dislikes on UX grounds). Visually the zone-kind chooser: a
 * button trigger + a listbox of options, each with an optional description line.
 *
 * Keyboard model (WAI-ARIA select-only combobox, plus the native `<select>`
 * habits operators already have):
 *
 *   Closed trigger   ↓ ↑ Enter Space Alt+↓  open, highlight the current value
 *                    letter(s)               type-ahead picks immediately - "T"
 *                                            selects TXT, "T" again TLSA, "TL" TLSA
 *                    Home / End              first / last option
 *   Open listbox     ↓ ↑ Home End PgUp PgDn  move the highlight (clamped)
 *                    letter(s)               type-ahead moves the highlight
 *                    Enter / Space           pick the highlighted option
 *                    Esc                     close, keep the value, stay focused
 *                    Tab                     close and move on
 *
 * Long lists (`searchable`, auto-on from 10 options) get a filter box at the
 * top of the listbox that takes focus on open; typing narrows by label and
 * description, so "ipv4" finds A and "mail" finds MX.
 *
 * Escape is handled on the trigger / filter input and stopped there, so a
 * dialog hosting the menu stays open - only the menu closes.
 *
 * The listbox is PORTALED to <body> with fixed positioning anchored to the
 * trigger, so it never clips inside `overflow-hidden`/scrolling containers
 * (tables, panels, modals) the way an absolutely-positioned child would. Its
 * z-index sits above the modal layer so it works inside dialogs/wizards too.
 *
 * Generic over the option value (a string union), so callers keep type safety:
 *   <SelectMenu value={algo} options={ALGORITHMS} onChange={setAlgo} />
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";
import {
  extendTypeaheadBuffer,
  filterOptionIndexes,
  findTypeaheadIndex,
  isTypeaheadKey,
  moveIndex,
} from "./select-menu-keys";

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
  /** Id for the trigger so a visible `<label htmlFor>` can point at it. */
  id?: string;
  className?: string;
  /**
   * Show a filter box inside the open listbox. Defaults to `"auto"`: on
   * for 10+ options, off below that (a 3-item kind picker doesn't need
   * a search field in the way).
   */
  searchable?: boolean | "auto";
  /** Placeholder for the filter box. */
  searchPlaceholder?: string;
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

const SEARCHABLE_AUTO_THRESHOLD = 10;
/** Rows a PageUp/PageDown press skips. */
const PAGE_STEP = 5;

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
  id,
  className,
  searchable = "auto",
  searchPlaceholder = "Type to filter…",
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [query, setQuery] = useState("");
  /** Index into `options` (not into the filtered list) of the highlighted row. */
  const [activeIndex, setActiveIndex] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();
  const optionId = (idx: number) => `${listId}-opt-${idx}`;

  const hasSearch =
    searchable === true || (searchable === "auto" && options.length >= SEARCHABLE_AUTO_THRESHOLD);

  const currentIndex = options.findIndex((o) => o.value === value);
  const current = currentIndex === -1 ? undefined : options[currentIndex];

  // What the listbox shows: every option, or the filtered subset while a
  // query is typed. Indexes point back into `options` so `activeIndex` is
  // stable whichever view is on screen.
  const visible = useMemo(
    () => (hasSearch && query ? filterOptionIndexes(options, query) : options.map((_, i) => i)),
    [hasSearch, options, query],
  );

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
    const MENU_MAX = 320; // the listbox's natural cap (max-h-80)
    const spaceBelow = window.innerHeight - b.bottom - GAP - EDGE;
    const spaceAbove = b.top - GAP - EDGE;
    // Flip up only when the menu can't get its full height below AND there's more
    // room above. Anchoring the up-menu by its BOTTOM edge means it sits directly
    // above the trigger regardless of how many options it holds - no measuring.
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

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  function openMenu() {
    if (disabled) return;
    reposition(); // compute the anchor BEFORE first paint - no flash
    setActiveIndex(currentIndex);
    setQuery("");
    setOpen(true);
  }

  function pick(idx: number) {
    const opt = options[idx];
    if (!opt) return;
    if (opt.value !== value) onChange(opt.value);
    close();
    // Selection made from the filter box must hand focus back to the
    // trigger, otherwise focus falls to <body> when the portal unmounts
    // and the next Tab press starts from the top of the page.
    btnRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.parentElement?.contains(t)) return;
      close();
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", reposition);
    // Capture phase so nested scroll containers also keep the menu aligned.
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition, close]);

  // Focus the filter box as soon as the listbox is in the DOM, and keep the
  // highlighted row scrolled into view as the keyboard moves it.
  useLayoutEffect(() => {
    if (!open) return;
    if (hasSearch) searchRef.current?.focus();
  }, [open, hasSearch]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from the stable useId, so it's safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  // When the filter narrows the list, keep the highlight on something visible.
  useEffect(() => {
    if (!open || !hasSearch) return;
    if (visible.length === 0) {
      setActiveIndex(-1);
      return;
    }
    if (!visible.includes(activeIndex)) setActiveIndex(visible[0]!);
  }, [open, hasSearch, visible, activeIndex]);

  /** Move the highlight within the *visible* rows, clamped. */
  function moveActive(delta: number) {
    const pos = visible.indexOf(activeIndex);
    const nextPos = moveIndex(pos, delta, visible.length);
    if (nextPos >= 0) setActiveIndex(visible[nextPos]!);
  }

  function applyTypeahead(key: string): number {
    typeahead.current = extendTypeaheadBuffer(typeahead.current, key, Date.now());
    const scope = visible.map((i) => options[i]!);
    const pos = findTypeaheadIndex(scope, typeahead.current.text, visible.indexOf(activeIndex));
    return pos === -1 ? -1 : visible[pos]!;
  }

  /** Keys on the trigger button - both when closed and (no-search) when open. */
  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const mods = { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };

    if (!open) {
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp":
        case "Enter":
        case " ":
          e.preventDefault();
          openMenu();
          return;
        case "Home":
          e.preventDefault();
          if (options[0]) pick(0);
          return;
        case "End":
          e.preventDefault();
          if (options.length) pick(options.length - 1);
          return;
        default:
          if (isTypeaheadKey(e.key, mods)) {
            // Native-select behaviour: type-ahead on a closed select changes
            // the value straight away. No need to open the menu to hit "T".
            const idx = applyTypeahead(e.key);
            if (idx !== -1) {
              e.preventDefault();
              const opt = options[idx]!;
              if (opt.value !== value) onChange(opt.value);
            }
          }
      }
      return;
    }

    // Open, focus on the trigger (non-searchable variant).
    onListKeyDown(e, mods);
  }

  /** Shared open-listbox key handling for the trigger and the filter box. */
  function onListKeyDown(
    e: ReactKeyboardEvent<HTMLElement>,
    mods: { ctrl: boolean; meta: boolean; alt: boolean },
  ) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        return;
      case "PageDown":
        e.preventDefault();
        moveActive(PAGE_STEP);
        return;
      case "PageUp":
        e.preventDefault();
        moveActive(-PAGE_STEP);
        return;
      case "Home":
        if (hasSearch && !e.ctrlKey) return; // let the caret move inside the filter box
        e.preventDefault();
        if (visible.length) setActiveIndex(visible[0]!);
        return;
      case "End":
        if (hasSearch && !e.ctrlKey) return;
        e.preventDefault();
        if (visible.length) setActiveIndex(visible[visible.length - 1]!);
        return;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && visible.includes(activeIndex)) pick(activeIndex);
        else close();
        return;
      case " ":
        if (hasSearch) return; // typing a space into the filter
        e.preventDefault();
        if (activeIndex >= 0) pick(activeIndex);
        return;
      case "Escape":
        // Stop here so a surrounding <Dialog> (which listens on document)
        // doesn't close as well - Esc on an open menu means "close the menu".
        e.preventDefault();
        e.stopPropagation();
        close();
        btnRef.current?.focus();
        return;
      case "Tab":
        // Close and put focus on the trigger *before* the default Tab runs,
        // so the browser moves on from the trigger rather than from a node
        // in the portal at the end of <body>.
        close();
        btnRef.current?.focus();
        return;
      default:
        if (!hasSearch && isTypeaheadKey(e.key, mods)) {
          e.preventDefault();
          const idx = applyTypeahead(e.key);
          if (idx !== -1) setActiveIndex(idx);
        }
    }
  }

  const activeDescendant =
    open && activeIndex >= 0 && visible.includes(activeIndex) ? optionId(activeIndex) : undefined;

  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        onBlur={(e) => {
          // Focus moving into the portaled filter box is not "leaving".
          const next = e.relatedTarget as Node | null;
          if (next && listRef.current?.parentElement?.contains(next)) return;
          if (open && !hasSearch) close();
        }}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={hasSearch ? undefined : activeDescendant}
        aria-label={ariaLabel}
        className="flex w-full items-center justify-between rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-left text-sm hover:border-[color:var(--color-fg-muted)] focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none disabled:opacity-60"
      >
        <span className={current ? "truncate" : "truncate text-[color:var(--color-fg-muted)]"}>
          {current ? current.label : (placeholder ?? "Select…")}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 10 10"
          aria-hidden
          className={`ml-2 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
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
            <div
              style={{
                top: anchor.top,
                bottom: anchor.bottom,
                left: anchor.left,
                width: anchor.width,
                maxHeight: anchor.maxHeight,
              }}
              className="fixed z-[200] flex flex-col overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-sm shadow-lg"
            >
              {hasSearch ? (
                <div className="relative border-b border-[color:var(--color-border)] p-1.5">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-3.5 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-fg-muted)]"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) =>
                      onListKeyDown(e, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey })
                    }
                    onBlur={(e) => {
                      const next = e.relatedTarget as Node | null;
                      if (next && (btnRef.current === next || listRef.current?.contains(next)))
                        return;
                      // Clicking an option fires mousedown (which picks) before
                      // blur, so by the time we get here with no related target
                      // the menu is already closing or focus truly left.
                      if (!next) return;
                      close();
                    }}
                    placeholder={searchPlaceholder}
                    aria-label={ariaLabel ? `Filter ${ariaLabel}` : "Filter options"}
                    aria-controls={listId}
                    aria-activedescendant={activeDescendant}
                    aria-autocomplete="list"
                    role="combobox"
                    aria-expanded
                    autoComplete="off"
                    spellCheck={false}
                    className="block w-full rounded border border-transparent bg-[color:var(--color-bg-subtle)] py-1 pr-2 pl-7 text-sm focus:border-[color:var(--color-accent)] focus:outline-none"
                  />
                </div>
              ) : null}
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={ariaLabel}
                className="min-h-0 flex-1 overflow-auto py-1"
              >
                {visible.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
                    No matches for “{query}”
                  </li>
                ) : null}
                {visible.map((idx) => {
                  const o = options[idx]!;
                  const selected = idx === currentIndex;
                  const active = idx === activeIndex;
                  return (
                    <li
                      key={o.value}
                      id={optionId(idx)}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(idx);
                      }}
                      onMouseMove={() => {
                        if (!active) setActiveIndex(idx);
                      }}
                      className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${
                        active ? "bg-[color:var(--color-bg-subtle)]" : ""
                      } ${selected ? "font-medium" : ""}`}
                    >
                      <Check
                        aria-hidden
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                          selected ? "text-[color:var(--color-accent)]" : "invisible"
                        }`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{o.label}</span>
                        {o.description ? (
                          <span className="block text-xs text-[color:var(--color-fg-muted)]">
                            {o.description}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
