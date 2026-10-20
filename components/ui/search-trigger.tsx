"use client";

/**
 * components/ui/search-trigger.tsx
 *
 * The header button that opens the global search palette: a search icon, a
 * label naming what it searches and the shortcut hint, shaped like an input so
 * it reads as "type here". Centred in the top bar from `md` up and collapses to
 * the icon alone below it.
 *
 * The hint says "Ctrl K" on the server render and switches to "⌘K" after
 * mount on Apple platforms: the platform is only knowable in the browser, and
 * rendering it on the server would mismatch hydration.
 */

import { useEffect, useState, type Ref } from "react";
import { Search } from "lucide-react";

function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(nav.userAgent);
}

/** "⌘K" on Apple platforms once mounted, "Ctrl K" everywhere else and on the server. */
export function useShortcutLabel(): string {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    setApple(isApplePlatform());
  }, []);
  return apple ? "⌘K" : "Ctrl K";
}

export function SearchTrigger({
  onOpen,
  expanded,
  ref,
}: {
  onOpen: () => void;
  expanded: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const shortcut = useShortcutLabel();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-keyshortcuts="Control+K Meta+K"
      aria-label={`Search (${shortcut})`}
      data-search-trigger=""
      className="group inline-flex h-9 w-9 items-center justify-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] text-sm text-[color:var(--color-fg-muted)] shadow-sm transition-[color,background-color,border-color,box-shadow] hover:border-[color:var(--color-fg-subtle)] hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-fg)] focus-visible:border-[color:var(--color-accent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] motion-reduce:transition-none md:w-full md:justify-start md:pr-1.5 md:pl-3.5"
    >
      <Search
        aria-hidden
        className="h-4 w-4 shrink-0 transition-colors group-hover:text-[color:var(--color-accent)] motion-reduce:transition-none"
      />
      <span className="hidden flex-1 truncate text-left md:inline">
        Search zones, records, settings…
      </span>
      <kbd className="hidden rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 font-mono text-[0.7rem] leading-5 text-[color:var(--color-fg-muted)] md:inline">
        {shortcut}
      </kbd>
    </button>
  );
}
