"use client";

/**
 * components/domain/ptr-links.tsx
 *
 * Reverse-DNS cross-link chips for the record tables. On a forward zone every
 * A/AAAA row gets a chip saying what the PTR for that address resolves to; on
 * a reverse zone every PTR row gets a chip naming the A/AAAA record(s) that
 * point back at the address. Each chip links to the other zone's page in a
 * new tab so the operator can fix a stale pair without losing their place.
 *
 * Data comes from `GET /api/admin/pdns/auto-ptr/links`, fetched once per
 * (zone, backend) after the table renders - the zone page itself never waits
 * on a fleet-wide scan. Every failure mode degrades to "no chip": loading,
 * 403 (the actor may not read links for this zone), network errors, and the
 * per-row `unhosted` / `unreadable` statuses. The chip is a hint, never a
 * gate, so it must never make the table look broken.
 *
 * Label rules live in `ptr-links-format.ts`; this file only fetches and renders.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/client/api-fetch";
import {
  addressChipModel,
  ownerChipModel,
  type AddressLink,
  type ChipTone,
  type OwnerLink,
  type PtrLinksData,
} from "./ptr-links-format";

export type { AddressLink, ForwardLink, OwnerLink, PtrLinksData } from "./ptr-links-format";
export { lookupAddressLink, lookupOwnerLink } from "./ptr-links-format";

interface UsePtrLinksOptions {
  /** Canonical zone name (trailing dot). */
  zone: string;
  serverSlug: string;
  /** `false` skips the fetch entirely (e.g. a table with no address/PTR rows). */
  enabled: boolean;
}

interface UsePtrLinksResult {
  data: PtrLinksData | null;
  loading: boolean;
}

/**
 * Fetch the cross-links for one zone on one backend. Re-fetches only when the
 * (zone, serverSlug) pair changes; an in-flight request is aborted when the
 * pair changes or the component unmounts so a slow answer for the previous
 * zone can't land on the new one.
 */
export function usePtrLinks({ zone, serverSlug, enabled }: UsePtrLinksOptions): UsePtrLinksResult {
  const [state, setState] = useState<{ key: string; data: PtrLinksData | null; loading: boolean }>({
    key: "",
    data: null,
    loading: false,
  });
  const key = `${serverSlug}\u0000${zone}`;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ key, data: null, loading: true });

    const params = new URLSearchParams({ zone, serverSlug });
    // Every failure collapses to `null` (= no chips) by design, see the module
    // comment; there is nothing to surface to the operator and nothing to retry.
    void apiFetch(`/api/admin/pdns/auto-ptr/links?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        // Any non-2xx (403 included) means "no chips", and the error envelope
        // carries nothing the table could act on, so the body is not read.
        if (!response.ok) return null;
        const body: unknown = await response.json().catch(() => null);
        return parsePtrLinks(body);
      })
      .catch(() => null)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ key, data, loading: false });
      });

    return () => controller.abort();
  }, [key, zone, serverSlug, enabled]);

  // While the effect for a new key has not run yet, the previous zone's data
  // must not leak into the new zone's rows.
  if (state.key !== key) return { data: null, loading: enabled };
  return { data: state.data, loading: state.loading };
}

/**
 * Narrow the JSON body to the wire contract. Only the discriminator and the
 * map's presence are checked: the route is first-party and the chips read the
 * per-entry fields defensively (`?? []`, `?? null`).
 */
function parsePtrLinks(body: unknown): PtrLinksData | null {
  if (!isPlainObject(body)) return null;
  const { kind, zone, byAddress, byOwner } = body as Partial<{
    kind: unknown;
    zone: unknown;
    byAddress: unknown;
    byOwner: unknown;
  }>;
  if (typeof zone !== "string") return null;
  if (kind === "forward" && isPlainObject(byAddress)) {
    return { kind: "forward", zone, byAddress: byAddress as Record<string, AddressLink> };
  }
  if (kind === "reverse" && isPlainObject(byOwner)) {
    return { kind: "reverse", zone, byOwner: byOwner as Record<string, OwnerLink> };
  }
  return null;
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ===== Chips ================================================================

const CHIP_BASE =
  "inline-flex max-w-[14rem] items-center gap-1 rounded border px-1.5 py-0.5 align-middle font-mono text-[0.65rem] leading-tight whitespace-nowrap no-underline";

const TONE_CLASS: Record<ChipTone, string> = {
  ok: "border-[color:var(--color-success)] text-[color:var(--color-success-fg)] hover:bg-[color:var(--color-bg-subtle)]",
  warn: "border-[color:var(--color-warn)] text-[color:var(--color-warn-fg)] hover:bg-[color:var(--color-bg-subtle)]",
  muted: "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]",
};

const ICON_CLASS = "h-3 w-3 shrink-0";

interface AddressPtrChipProps {
  link: AddressLink | undefined;
  /** Owner of the A/AAAA row; picks the shown target when the PTR has several. */
  recordName?: string;
}

/**
 * Chip for an A/AAAA row: what the PTR for this address says. Renders nothing
 * until data arrives and for addresses the actor cannot follow.
 */
export function AddressPtrChip({ link, recordName }: AddressPtrChipProps) {
  const model = addressChipModel(link, recordName);
  if (!model) return null;

  return (
    <span className="ml-2 inline-flex items-center gap-1 align-middle">
      <ChipLink tone={model.tone} href={model.href} title={model.title} label={model.label} />
      {model.allTargets.length > 1 ? (
        <ChipPopover
          tone={model.tone}
          label={`${model.allTargets.length} targets`}
          title="Every name the reverse record points at"
        >
          <ul className="space-y-0.5">
            {model.allTargets.map((target) => (
              <li key={target} className="truncate" title={target}>
                {target}
              </li>
            ))}
          </ul>
        </ChipPopover>
      ) : null}
    </span>
  );
}

interface OwnerPtrChipProps {
  link: OwnerLink | undefined;
  /** The PTR row's owner name; only used for the popover's accessible label. */
  ownerName: string;
}

/**
 * Chip for a PTR row: which A/AAAA record(s) point back at this address. One
 * name links straight to its zone; several open a list with a link each.
 */
export function OwnerPtrChip({ link, ownerName }: OwnerPtrChipProps) {
  const model = ownerChipModel(link);
  if (!model) return null;

  if (model.entries.length === 0) {
    return (
      <span className="ml-2 inline-flex items-center align-middle">
        <ChipLink tone={model.tone} href={model.href} title={model.title} label={model.label} />
      </span>
    );
  }

  return (
    <span className="ml-2 inline-flex items-center align-middle">
      <ChipPopover
        tone={model.tone}
        label={model.label}
        title={`${model.title}. Click to list them.`}
        panelLabel={`Forward records for ${ownerName}`}
      >
        <ul className="space-y-0.5">
          {model.entries.map((entry) => (
            <li
              key={`${entry.server}/${entry.zone}/${entry.name}/${entry.type}`}
              className="flex items-center gap-1.5"
            >
              <span
                className={`${ICON_CLASS} inline-flex items-center justify-center`}
                aria-hidden={!entry.matchesPtr}
                title={entry.matchesPtr ? "This is the PTR's target" : undefined}
              >
                {entry.matchesPtr ? (
                  <Check className={`${ICON_CLASS} text-[color:var(--color-success-fg)]`} />
                ) : null}
              </span>
              <span className="w-10 shrink-0 text-[color:var(--color-fg-muted)]">{entry.type}</span>
              <span className="min-w-0 flex-1 truncate" title={entry.name}>
                {entry.name}{" "}
                <span className="text-[color:var(--color-fg-subtle)]">({trimDot(entry.zone)})</span>
              </span>
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${entry.name} in ${trimDot(entry.zone)} (new tab)`}
                className="shrink-0 rounded p-0.5 text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-subtle)]"
              >
                <ExternalLink className={ICON_CLASS} aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      </ChipPopover>
    </span>
  );
}

// ===== Building blocks =====================================================

interface ChipLinkProps {
  tone: ChipTone;
  href: string | null;
  title: string;
  label: string;
}

/** A chip that is a new-tab link when `href` is known, a plain badge otherwise. */
function ChipLink({ tone, href, title, label }: ChipLinkProps) {
  const text = (
    <span className="truncate" title={label}>
      {label}
    </span>
  );
  if (!href) {
    return (
      <span className={`${CHIP_BASE} ${TONE_CLASS[tone]}`} title={title}>
        {text}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${title} (opens in a new tab)`}
      className={`${CHIP_BASE} ${TONE_CLASS[tone]}`}
    >
      {text}
      <ExternalLink className={ICON_CLASS} aria-hidden />
    </a>
  );
}

interface ChipPopoverProps {
  tone: ChipTone;
  label: string;
  title: string;
  panelLabel?: string;
  children: React.ReactNode;
}

/**
 * A chip-shaped toggle with a small panel underneath. The panel is laid out
 * in flow (it grows the row) rather than absolutely positioned: the shared
 * DataTable wraps its rows in `overflow-hidden` + `overflow-x-auto`, which
 * would clip a floating panel on the last rows or give the table a stray
 * vertical scrollbar. In flow it also behaves on the mobile card layout.
 *
 * Esc closes and returns focus to the chip; a click anywhere outside closes.
 * Escape is stopped from bubbling so the record table's own Esc handling
 * (close inline editor, back out of a draft) is not triggered as a side
 * effect of dismissing a chip list.
 */
function ChipPopover({ tone, label, title, panelLabel, children }: ChipPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <span ref={rootRef} className="inline-block align-middle" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        title={title}
        className={`${CHIP_BASE} ${TONE_CLASS[tone]} cursor-pointer`}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[0.55rem]">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <span
          id={panelId}
          role="group"
          aria-label={panelLabel ?? title}
          className="mt-1 block w-max max-w-[min(22rem,calc(100vw-3rem))] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-2 font-mono text-[0.65rem] whitespace-normal text-[color:var(--color-fg)] shadow-md"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

function trimDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}
