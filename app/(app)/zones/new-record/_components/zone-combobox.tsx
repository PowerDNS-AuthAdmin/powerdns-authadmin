"use client";

/**
 * app/(app)/zones/new-record/_components/zone-combobox.tsx
 *
 * Type-ahead over `GET /api/admin/pdns/zones/search` for the wizard's Zone
 * step. A text input (`role="combobox"`) drives a listbox of zones filtered
 * to the chosen horizon; each row names the zone, its backend and its
 * cluster, and a zone the caller may not create records in is listed but
 * not selectable, so the operator learns why it is missing rather than
 * wondering.
 *
 * The listbox is inline (not portaled): the wizard has the whole page, and an
 * inline list keeps the input, the results and the hint in one reading order
 * on a phone. Keyboard: Up/Down move, Home/End jump, Enter selects, Escape
 * closes; the active row is announced through `aria-activedescendant`.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { inputBaseClass } from "@/components/ui/form";
import { ZoneHorizonBadge } from "@/components/domain/zone-horizon-badge";
import { displayZoneName } from "@/lib/dns/zone-name";
import type { WizardHorizon, WizardZoneHit } from "@/components/domain/record-wizard-format";

const SEARCH_DEBOUNCE_MS = 200;

function describeResults(query: string, shown: number, total: number): string {
  if (shown === 0) {
    return query.trim() === ""
      ? "No zones you may read in this horizon."
      : `No zone matches "${query.trim()}".`;
  }
  if (total > shown) return `Showing ${shown} of ${total} zones. Keep typing to narrow the list.`;
  return `${shown} zone${shown === 1 ? "" : "s"}.`;
}
const RESULT_LIMIT = 50;

interface SearchResponse {
  zones: WizardZoneHit[];
  total: number;
}

export function ZoneCombobox({
  horizon,
  initialQuery = "",
  onSelect,
}: {
  horizon: WizardHorizon | null;
  initialQuery?: string;
  onSelect: (zone: WizardZoneHit) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<WizardZoneHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const statusId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Debounced search. The AbortController drops a slow earlier response that
  // would otherwise overwrite the result for what the operator typed last.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), limit: String(RESULT_LIMIT) });
      if (horizon) params.set("horizon", horizon);
      setLoading(true);
      fetch(`/api/admin/pdns/zones/search?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as
            | SearchResponse
            | { error?: string }
            | null;
          if (!response.ok || !body || !("zones" in body)) {
            const message =
              body && "error" in body && typeof body.error === "string"
                ? body.error
                : "Could not search zones.";
            throw new Error(message);
          }
          setHits(body.zones);
          setTotal(body.total);
          setError(null);
          setActiveIndex(body.zones.length > 0 ? 0 : -1);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Could not search zones.");
          setHits([]);
          setTotal(0);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, horizon]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const row = listRef.current?.children.item(activeIndex);
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function choose(index: number) {
    const hit = hits[index];
    if (!hit?.canCreate) return;
    setOpen(false);
    onSelect(hit);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => (hits.length === 0 ? -1 : Math.min(i + 1, hits.length - 1)));
        break;
      case "ArrowUp":
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => (hits.length === 0 ? -1 : Math.max(i - 1, 0)));
        break;
      case "Home":
        if (open && hits.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open && hits.length > 0) {
          event.preventDefault();
          setActiveIndex(hits.length - 1);
        }
        break;
      case "Enter":
        if (open && activeIndex >= 0) {
          event.preventDefault();
          choose(activeIndex);
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  }

  const activeId =
    open && activeIndex >= 0 && hits[activeIndex] ? optionId(activeIndex) : undefined;
  const statusText = loading ? "Searching…" : (error ?? describeResults(query, hits.length, total));

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[color:var(--color-fg-muted)]"
          aria-hidden
        />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-describedby={statusId}
          aria-label="Zone"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Type a zone name, for example example.com"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className={`${inputBaseClass} pl-9 font-mono`}
        />
      </div>

      <p id={statusId} className="text-xs text-[color:var(--color-fg-muted)]" aria-live="polite">
        {statusText}
      </p>

      {/* The list stays mounted (visually hidden when closed) so
          `aria-controls` always points at a real element. */}
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Matching zones"
        className={`max-h-80 overflow-y-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] ${
          open && hits.length > 0 ? "" : "hidden"
        }`}
      >
        {hits.map((hit, index) => {
          const active = index === activeIndex;
          return (
            <li
              key={`${hit.server}|${hit.name}`}
              id={optionId(index)}
              role="option"
              aria-selected={active}
              aria-disabled={!hit.canCreate}
              onMouseEnter={() => setActiveIndex(index)}
              // onMouseDown keeps the input focused through the click, so the
              // listbox does not close before the click registers.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              className={`flex flex-col gap-1 border-b border-[color:var(--color-border)] px-3 py-2 text-sm last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${
                hit.canCreate ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              } ${active ? "bg-[color:var(--color-bg-muted)]" : ""}`}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono break-all">{displayZoneName(hit.name)}</span>
                <ZoneHorizonBadge horizon={hit.horizon} />
                {hit.reverse ? (
                  <span className="rounded bg-[color:var(--color-bg-muted)] px-1 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase">
                    reverse
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-[color:var(--color-fg-muted)]">
                {hit.serverName}
                {hit.cluster ? ` · cluster ${hit.cluster}` : ""}
                {hit.canCreate ? "" : " · no permission to add records here"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
