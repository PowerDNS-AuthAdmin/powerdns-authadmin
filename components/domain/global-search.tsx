"use client";

/**
 * components/domain/global-search.tsx
 *
 * The global search palette: a header trigger plus a floating, centred panel
 * (a full-screen sheet under `md`) that fuzzy-searches zones, records, config,
 * the PowerDNS request log and the audit log through `GET /api/search`.
 *
 * Opens on Ctrl/Cmd K, on the trigger, or on "/" when focus is not in a text
 * field and the page has no primary list that already owns "/". The tab row
 * narrows the scope (remembered per browser); "All" shows labelled groups, a
 * single tab a denser list with that tab's columns inline. Arrow keys, Home
 * and End move through results, Enter opens one, Shift+Enter or a Cmd/Ctrl
 * click opens it in a new tab, Esc closes.
 *
 * Docs are deliberately not searched here; the footer hands the query to the
 * website's search instead. Which tabs exist is decided by the server (the
 * layout passes `visibility`), and every result is permission-filtered there.
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  ExternalLink,
  FileStack,
  FileText,
  Globe,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  Network,
  ScrollText,
  Search,
  SearchX,
  Server,
  Settings,
  Shield,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/client/api-fetch";
import type {
  SearchGroupKey,
  SearchItem,
  SearchItemKind,
  SearchQuickLink,
  SearchRange,
  SearchResponse,
  SearchScope,
  SearchTabVisibility,
} from "@/lib/search/types";
import {
  getTabbables,
  lockPage,
  ModalPortal,
  restoreFocus,
  unlockPage,
} from "@/components/ui/dialog";
import { isTypingTarget } from "@/components/ui/data-table";
import { SearchTrigger, useShortcutLabel } from "@/components/ui/search-trigger";

const DEBOUNCE_MS = 150;
const MAX_QUERY_LENGTH = 100;
const SCOPE_STORAGE_KEY = "pda.search.scope";
const DOCS_SEARCH_URL = "https://powerdns-authadmin.org/search/";

const TABS: ReadonlyArray<{ key: SearchScope; label: string }> = [
  { key: "all", label: "All" },
  { key: "zones", label: "Zones" },
  { key: "records", label: "Records" },
  { key: "config", label: "Config" },
  { key: "requests", label: "Requests" },
  { key: "audit", label: "Audit" },
];

const KIND_ICON: Record<SearchItemKind, LucideIcon> = {
  zone: Globe,
  record: FileText,
  setting: Settings,
  page: LayoutGrid,
  backend: Server,
  cluster: Network,
  user: User,
  team: Users,
  role: Shield,
  template: FileStack,
  "auth-provider": KeyRound,
  request: Activity,
  audit: ScrollText,
};

/** The inline columns of a single-tab list, in order, with their widths. */
const META_COLUMNS: Record<SearchGroupKey, ReadonlyArray<{ key: string; className: string }>> = {
  zones: [
    { key: "backend", className: "w-28" },
    { key: "horizon", className: "w-20" },
    { key: "kind", className: "w-20" },
  ],
  records: [
    { key: "type", className: "w-14 font-medium" },
    { key: "content", className: "w-56 font-mono" },
    { key: "zone", className: "w-36" },
  ],
  config: [
    { key: "section", className: "w-28" },
    { key: "value", className: "w-40" },
  ],
  requests: [
    { key: "method", className: "w-14 font-medium" },
    { key: "status", className: "w-12 tabular-nums" },
    { key: "backend", className: "w-24" },
    { key: "time", className: "w-40 tabular-nums" },
  ],
  audit: [
    { key: "actor", className: "w-32" },
    { key: "resource", className: "w-40" },
    { key: "time", className: "w-40 tabular-nums" },
  ],
};

type FetchState =
  | { status: "idle" }
  | { status: "loading"; previous: SearchResponse | null }
  | { status: "done"; data: SearchResponse }
  | { status: "error"; message: string };

/** One navigable row: a result, or a quick link while the query is empty. */
interface OptionRow {
  id: string;
  href: string;
}

function readStoredScope(): SearchScope | null {
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    return TABS.some((t) => t.key === raw) ? (raw as SearchScope) : null;
  } catch {
    return null;
  }
}

function storeScope(scope: SearchScope): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // Private mode / blocked storage: the scope simply is not remembered.
  }
}

function formatMeta(key: string, value: string): string {
  if (key !== "time") return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Render `text` with the matched spans wrapped in `<mark>`. */
function Highlighted({ text, ranges }: { text: string; ranges?: readonly SearchRange[] }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={i}
        className="rounded-sm bg-[color:var(--color-accent)]/20 px-px text-[color:var(--color-accent)]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-1 font-mono text-[0.68rem] leading-[18px] text-[color:var(--color-fg-muted)]">
      {children}
    </kbd>
  );
}

export interface GlobalSearchProps {
  /** Tabs the user may see; hidden tabs are neither shown nor requested. */
  visibility: SearchTabVisibility;
  /** Shortcuts for the empty state, already filtered to what the user can open. */
  quickLinks: readonly SearchQuickLink[];
}

export function GlobalSearch({ visibility, quickLinks }: GlobalSearchProps) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const titleId = `${baseId}-title`;
  const shortcut = useShortcutLabel();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [state, setState] = useState<FetchState>({ status: "idle" });
  const [active, setActive] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Map<SearchScope, HTMLButtonElement>>(new Map());

  const tabs = useMemo(
    () => TABS.filter((t) => t.key === "all" || visibility[t.key]),
    [visibility],
  );

  // Restore the remembered tab once, after mount (storage is browser-only).
  useEffect(() => {
    const stored = readStoredScope();
    if (stored && tabs.some((t) => t.key === stored)) setScope(stored);
  }, [tabs]);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  // Global shortcuts. Ctrl/Cmd K toggles from anywhere; "/" only when the
  // user is not typing and the page has no list that already claims "/".
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey) {
        const otherDialog = document.querySelector("[role=dialog]:not([data-global-search])");
        if (otherDialog) return;
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      if (document.querySelector("[data-search-shortcut]")) return;
      e.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Open/close lifecycle: page lock, initial focus, focus return.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    lockPage();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      unlockPage();
      restoreFocus(trigger);
    };
  }, [open]);

  const trimmed = query.trim();

  // Debounced fetch; each keystroke aborts the request before it.
  useEffect(() => {
    if (!open) return;
    if (trimmed.length === 0) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({
      status: "loading",
      previous: s.status === "done" ? s.data : s.status === "loading" ? s.previous : null,
    }));
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, scope });
      apiFetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then(async (res) => {
          if (res.status === 429) throw new Error("Searching too fast. Try again in a moment.");
          if (!res.ok) throw new Error("Search is unavailable right now.");
          const data = (await res.json()) as SearchResponse;
          setState({ status: "done", data });
          setActive(0);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Search failed.",
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, scope]);

  const data =
    state.status === "done" ? state.data : state.status === "loading" ? state.previous : null;
  const loading = state.status === "loading";
  const showingQuickLinks = trimmed.length === 0;

  const options: OptionRow[] = useMemo(() => {
    if (showingQuickLinks)
      return quickLinks.map((l, i) => ({ id: `${baseId}-quick-${i}`, href: l.href }));
    if (!data) return [];
    return data.groups.flatMap((g) =>
      g.items.map((it, i) => ({ id: `${baseId}-${g.key}-${i}`, href: it.href })),
    );
  }, [showingQuickLinks, quickLinks, data, baseId]);

  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1);
  const activeId = activeIndex >= 0 ? options[activeIndex]?.id : undefined;

  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const go = useCallback(
    (href: string, newTab: boolean) => {
      if (newTab) {
        window.open(href, "_blank", "noopener");
        return;
      }
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const selectScope = useCallback((next: SearchScope) => {
    setScope(next);
    setActive(0);
    storeScope(next);
  }, []);

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const count = options.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (count) setActive((activeIndex + 1) % count);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (count) setActive((activeIndex - 1 + count) % count);
        return;
      case "Home":
        if (!count) return;
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        if (!count) return;
        e.preventDefault();
        setActive(count - 1);
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        const i = tabs.findIndex((t) => t.key === scope);
        const step = e.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(i + step + tabs.length) % tabs.length];
        if (next) selectScope(next.key);
        return;
      }
      case "Enter": {
        const row = activeIndex >= 0 ? options[activeIndex] : undefined;
        if (!row) return;
        e.preventDefault();
        go(row.href, e.shiftKey || e.metaKey || e.ctrlKey);
        return;
      }
      default:
    }
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    selectScope(tab.key);
    tabRefs.current.get(tab.key)?.focus();
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = getTabbables(panelRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onOptionClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    // Let the browser handle new-tab / new-window gestures natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(href, false);
  }

  const docsHref = trimmed
    ? `${DOCS_SEARCH_URL}?q=${encodeURIComponent(trimmed)}`
    : DOCS_SEARCH_URL;
  const countFor = (key: SearchScope): number | null => {
    if (!data || showingQuickLinks) return null;
    if (key === "all")
      return Object.entries(data.counts).reduce(
        (sum, [k, n]) => sum + (visibility[k as SearchGroupKey] ? n : 0),
        0,
      );
    return data.counts[key];
  };

  let optionCursor = 0;
  const optionProps = (href: string) => {
    const index = optionCursor++;
    const id = options[index]?.id ?? `${baseId}-x-${index}`;
    const selected = index === activeIndex;
    return {
      id,
      role: "option" as const,
      "aria-selected": selected,
      tabIndex: -1,
      href,
      onMouseMove: () => {
        if (index !== activeIndex) setActive(index);
      },
      onClick: (e: React.MouseEvent<HTMLAnchorElement>) => onOptionClick(e, href),
      className: [
        "group/opt relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-[color:var(--color-fg)] no-underline outline-none",
        selected
          ? "bg-[color:var(--color-accent)]/10 ring-1 ring-[color:var(--color-accent)]/35 ring-inset"
          : "",
      ].join(" "),
    };
  };

  const renderIcon = (kind: SearchItemKind | "link", selected: boolean) => {
    const Icon = kind === "link" ? ArrowRight : KIND_ICON[kind];
    return (
      <span
        aria-hidden
        className={[
          "grid h-8 w-8 shrink-0 place-items-center rounded-lg border",
          selected
            ? "border-[color:var(--color-accent)]/40 bg-[color:var(--color-bg)] text-[color:var(--color-accent)]"
            : "border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-fg-muted)]",
        ].join(" ")}
      >
        <Icon className="h-4 w-4" />
      </span>
    );
  };

  const renderResult = (it: SearchItem, dense: boolean) => {
    const props = optionProps(it.href);
    const selected = props["aria-selected"];
    const columns = dense ? META_COLUMNS[it.group] : [];
    const cells = columns
      .map((c) => ({ ...c, value: it.meta?.[c.key] ?? "" }))
      .filter((c) => c.value !== "");
    // In a single tab the subtitle often repeats a column (a record's value,
    // a user's email); show it only where those columns are not visible.
    const subtitleInColumns =
      it.subtitle !== undefined && cells.some((c) => c.value.startsWith(it.subtitle!));
    return (
      <a key={props.id} {...props}>
        {renderIcon(it.kind, selected)}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">
            <Highlighted text={it.title} ranges={it.ranges} />
          </span>
          {it.subtitle && !(dense && subtitleInColumns) ? (
            <span className="truncate text-xs text-[color:var(--color-fg-muted)]">
              <Highlighted text={it.subtitle} ranges={it.subtitleRanges} />
            </span>
          ) : null}
          {cells.length > 0 ? (
            <span className="truncate text-xs text-[color:var(--color-fg-muted)] md:hidden">
              {cells.map((c) => formatMeta(c.key, c.value)).join(" · ")}
            </span>
          ) : null}
        </span>
        {dense ? (
          <span className="hidden shrink-0 items-center gap-3 text-xs text-[color:var(--color-fg-muted)] md:flex">
            {columns.map((c) => {
              const value = it.meta?.[c.key] ?? "";
              const highlightable =
                subtitleInColumns && it.subtitle !== undefined && value.startsWith(it.subtitle);
              return (
                <span key={c.key} className={`truncate ${c.className}`} title={value}>
                  {highlightable ? (
                    <Highlighted text={value} ranges={it.subtitleRanges} />
                  ) : (
                    formatMeta(c.key, value)
                  )}
                </span>
              );
            })}
          </span>
        ) : null}
        <ArrowRight
          aria-hidden
          className={[
            "hidden h-4 w-4 shrink-0 text-[color:var(--color-accent)] transition-opacity motion-reduce:transition-none md:block",
            selected ? "opacity-100" : "opacity-0",
          ].join(" ")}
        />
      </a>
    );
  };

  const groupHeading = (id: string, label: string, extra?: React.ReactNode) => (
    <div
      id={id}
      className="flex items-center justify-between px-2.5 pt-2 pb-1 text-[0.7rem] font-semibold tracking-wider text-[color:var(--color-fg-subtle)] uppercase"
    >
      <span>{label}</span>
      {extra}
    </div>
  );

  let body: React.ReactNode;
  if (showingQuickLinks) {
    body =
      quickLinks.length > 0 ? (
        <div role="group" aria-labelledby={`${baseId}-quick-label`}>
          {groupHeading(`${baseId}-quick-label`, "Jump to")}
          <div className="grid grid-cols-1 gap-0.5 md:grid-cols-2">
            {quickLinks.map((l) => {
              const props = optionProps(l.href);
              return (
                <a key={props.id} {...props}>
                  {renderIcon("link", props["aria-selected"])}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{l.label}</span>
                    {l.hint ? (
                      <span className="truncate text-xs text-[color:var(--color-fg-muted)]">
                        {l.hint}
                      </span>
                    ) : null}
                  </span>
                </a>
              );
            })}
          </div>
          <p className="mx-2.5 mt-3 mb-1 rounded-lg bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
            Search zone names, record names and values, settings, people, backends and the logs.
            Letters can be skipped: <code className="font-mono">exmp</code> finds{" "}
            <code className="font-mono">example.com</code>.
          </p>
        </div>
      ) : null;
  } else if (state.status === "error") {
    body = (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-[color:var(--color-fg-muted)]">
        <p>{state.message}</p>
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex justify-center px-4 py-10 text-sm text-[color:var(--color-fg-muted)]">
        <LoaderCircle aria-hidden className="h-5 w-5 motion-safe:animate-spin" />
        <span className="sr-only">Searching</span>
      </div>
    );
  } else if (data.groups.length === 0) {
    body = (
      <div className="flex flex-col items-center px-4 pt-8 pb-6 text-center">
        <span
          aria-hidden
          className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-fg-subtle)]"
        >
          <SearchX className="h-6 w-6" />
        </span>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No matches for <strong className="text-[color:var(--color-fg)]">{trimmed}</strong>
          {scope !== "all" ? ` in ${tabs.find((t) => t.key === scope)?.label ?? scope}` : ""}.
        </p>
        {scope !== "all" ? (
          <button
            type="button"
            onClick={() => selectScope("all")}
            className="mt-2 text-sm text-[color:var(--color-accent)] hover:underline"
          >
            Search all tabs
          </button>
        ) : null}
      </div>
    );
  } else {
    const dense = data.scope !== "all";
    body = data.groups.map((g, groupIndex) => {
      const labelId = `${baseId}-group-${g.key}`;
      const more =
        !dense && g.total > g.items.length ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => selectScope(g.key)}
            className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium tracking-normal text-[color:var(--color-fg-muted)] normal-case hover:text-[color:var(--color-accent)]"
          >
            All {g.total}
          </button>
        ) : (
          <span className="font-mono tracking-normal tabular-nums">{g.total}</span>
        );
      return (
        <div
          key={g.key}
          role="group"
          aria-labelledby={labelId}
          className={
            groupIndex > 0 ? "mt-1 border-t border-[color:var(--color-border)] pt-1" : "pt-1"
          }
        >
          {groupHeading(labelId, g.label, more)}
          {g.items.map((it) => (
            <Fragment key={`${g.key}-${it.href}-${it.title}`}>{renderResult(it, dense)}</Fragment>
          ))}
          {dense && g.total > g.items.length ? (
            <p className="px-2.5 pt-2 pb-1 text-xs text-[color:var(--color-fg-subtle)]">
              Showing the best {g.items.length} of {g.total}. Keep typing to narrow it down.
            </p>
          ) : null}
        </div>
      );
    });
  }

  return (
    <>
      <SearchTrigger ref={triggerRef} onOpen={openPalette} expanded={open} />
      {open ? (
        <ModalPortal>
          <div className="fixed inset-0 z-[100] flex md:items-start md:justify-center md:px-4 md:pt-[11vh]">
            <div
              aria-hidden
              onClick={closePalette}
              className="pda-search-backdrop absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              data-global-search=""
              onKeyDown={onPanelKeyDown}
              className="pda-search-panel relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[color:var(--color-bg)] text-[color:var(--color-fg)] md:h-auto md:max-h-[min(680px,calc(100vh-11vh-2rem))] md:max-w-3xl md:rounded-xl md:border md:border-[color:var(--color-border)] md:shadow-2xl"
            >
              <h2 id={titleId} className="sr-only">
                Search
              </h2>
              <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-[color:var(--color-border)] pr-2 pl-4">
                {loading ? (
                  <LoaderCircle
                    aria-hidden
                    className="h-5 w-5 shrink-0 text-[color:var(--color-accent)] motion-safe:animate-spin"
                  />
                ) : (
                  <Search
                    aria-hidden
                    className="h-5 w-5 shrink-0 text-[color:var(--color-accent)]"
                  />
                )}
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={options.length > 0}
                  aria-controls={listboxId}
                  aria-activedescendant={activeId}
                  aria-autocomplete="list"
                  aria-label="Search zones, records, config and logs"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  maxLength={MAX_QUERY_LENGTH}
                  value={query}
                  placeholder="Search zones, records, config…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onInputKeyDown}
                  className="h-14 min-w-0 flex-1 border-0 bg-transparent p-0 text-base outline-none placeholder:text-[color:var(--color-fg-subtle)] focus-visible:outline-none md:text-[1.05rem]"
                />
                <button
                  type="button"
                  onClick={closePalette}
                  className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-subtle)] md:text-[color:var(--color-fg-muted)]"
                >
                  <span className="md:hidden">Cancel</span>
                  <span className="hidden md:inline">
                    <Kbd>Esc</Kbd>
                    <span className="sr-only"> Close search</span>
                  </span>
                </button>
              </div>

              <div
                role="tablist"
                aria-label="Search scope"
                className="flex shrink-0 [scrollbar-width:none] gap-1.5 overflow-x-auto border-b border-[color:var(--color-border)] px-3 py-2"
              >
                {tabs.map((t, i) => {
                  const selected = t.key === scope;
                  const count = countFor(t.key);
                  return (
                    <button
                      key={t.key}
                      ref={(el) => {
                        if (el) tabRefs.current.set(t.key, el);
                        else tabRefs.current.delete(t.key);
                      }}
                      type="button"
                      role="tab"
                      id={`${baseId}-tab-${t.key}`}
                      aria-selected={selected}
                      aria-controls={listboxId}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => {
                        selectScope(t.key);
                        inputRef.current?.focus();
                      }}
                      onKeyDown={(e) => onTabKeyDown(e, i)}
                      className={[
                        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors motion-reduce:transition-none",
                        selected
                          ? "border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]"
                          : "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                      ].join(" ")}
                    >
                      {t.label}
                      {count !== null ? (
                        <span
                          className={[
                            "font-mono text-[0.68rem] tabular-nums",
                            selected
                              ? "text-[color:var(--color-accent)]"
                              : "text-[color:var(--color-fg-subtle)]",
                          ].join(" ")}
                        >
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div
                id={listboxId}
                role="listbox"
                aria-labelledby={`${baseId}-tab-${scope}`}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-3"
              >
                {body}
              </div>

              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-[color:var(--color-fg-subtle)]">
                <div
                  aria-hidden
                  className="hidden flex-wrap items-center gap-x-3.5 gap-y-1 md:flex"
                >
                  <span className="inline-flex items-center gap-1">
                    <Kbd>
                      <ArrowUp className="h-3 w-3" />
                    </Kbd>
                    <Kbd>
                      <ArrowDown className="h-3 w-3" />
                    </Kbd>
                    move
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>←</Kbd>
                    <Kbd>→</Kbd>
                    tabs
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>
                      <CornerDownLeft className="h-3 w-3" />
                    </Kbd>
                    open
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>⇧</Kbd>
                    <Kbd>
                      <CornerDownLeft className="h-3 w-3" />
                    </Kbd>
                    new tab
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>{shortcut}</Kbd>
                    toggle
                  </span>
                </div>
                <a
                  href={docsHref}
                  target="_blank"
                  rel="noopener"
                  className="ml-auto inline-flex items-center gap-1 text-right text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)]"
                >
                  Looking for docs instead? Search powerdns-authadmin.org
                  <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
                </a>
              </div>
            </div>
          </div>
        </ModalPortal>
      ) : null}
    </>
  );
}
