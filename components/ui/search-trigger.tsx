"use client";

/**
 * components/ui/search-trigger.tsx
 *
 * The header button that opens the global search palette: a search icon, a
 * "Search…" label and the shortcut hint, shaped like an input so it reads as
 * "type here". Collapses to the icon alone under `sm`.
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
      className="group inline-flex h-9 w-9 items-center justify-center gap-2 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] text-sm text-[color:var(--color-fg-muted)] shadow-sm transition-colors hover:bg-[color:var(--color-bg)] hover:text-[color:var(--color-fg)] focus-visible:border-[color:var(--color-accent)] motion-reduce:transition-none sm:w-56 sm:justify-start sm:pr-1.5 sm:pl-3"
    >
      <Search
        aria-hidden
        className="h-4 w-4 shrink-0 transition-colors group-hover:text-[color:var(--color-accent)] motion-reduce:transition-none"
      />
      <span className="hidden flex-1 truncate text-left sm:inline">Search…</span>
      <kbd className="hidden rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 font-mono text-[0.7rem] leading-5 text-[color:var(--color-fg-muted)] sm:inline">
        {shortcut}
      </kbd>
    </button>
  );
}
