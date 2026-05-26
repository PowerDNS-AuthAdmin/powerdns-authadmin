"use client";

/**
 * components/realtime/header-status-chip.tsx
 *
 * The SSE connection chip that lives in the top header (left, just past the
 * hamburger). One chip for the whole app — its *label* varies per page:
 *
 *   • Dashboard (default)         → "Live"
 *   • Zones, Zone detail, Servers → "Synced" / "Desynced" (replication aware)
 *
 * Pages set the label by mounting a tiny <HeaderStatusMode/> client component
 * (no UI, just pushes the desired mode into context). When the page unmounts
 * the mode resets to the default "live" label.
 *
 * The chip itself reads the connection state from RealtimeProvider, which
 * already applies a 5 s grace before reporting "offline" — so a Ctrl-R won't
 * flash offline → connecting → live, only connecting → live.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SyncIndicator } from "@/components/ui/sync-indicator";
import { useRealtimeAvailable, useRealtimeStatus } from "./realtime-provider";

type Mode = { kind: "live" } | { kind: "sync"; inSync: boolean };
const FALLBACK_MODE: Mode = { kind: "live" };

interface HeaderStatusContextValue {
  mode: Mode;
  setOverride: (mode: Mode | null) => void;
}

const HeaderStatusContext = createContext<HeaderStatusContextValue | null>(null);

/**
 * `initialMode` is the chip's default for pages that don't push their own
 * sync state via `<HeaderStatusMode/>`. The app shell passes the fleet-wide
 * verdict from `globalAnyLagging()` here so every page has a meaningful chip,
 * not a generic "Live" label. Per-page `<HeaderStatusMode/>` sets a transient
 * override (zone detail's per-zone view, zones-list's amalgamated view); on
 * unmount the override clears and the chip falls back to whatever the layout
 * is currently rendering — a router.refresh after a mutation re-runs the
 * layout, so the global verdict stays fresh without prop-syncing into state.
 */
export function HeaderStatusProvider({
  children,
  initialMode = FALLBACK_MODE,
}: {
  children: ReactNode;
  initialMode?: Mode;
}) {
  const [override, setOverride] = useState<Mode | null>(null);
  const mode = override ?? initialMode;
  return (
    <HeaderStatusContext.Provider value={{ mode, setOverride }}>
      {children}
    </HeaderStatusContext.Provider>
  );
}

function useHeaderStatus(): HeaderStatusContextValue {
  return (
    useContext(HeaderStatusContext) ?? {
      mode: FALLBACK_MODE,
      setOverride: () => undefined,
    }
  );
}

/**
 * Tiny no-UI helper a page mounts to tell the header chip what label/state to
 * show. Clears the override on unmount, so leaving the page falls the chip
 * back to the provider's initialMode (the layout's fleet-wide verdict).
 */
export function HeaderStatusMode(props: { kind: "live" } | { kind: "sync"; inSync: boolean }) {
  const { setOverride } = useHeaderStatus();
  // Stringify the props so the effect only re-runs when something *actually*
  // changes (object identity changes every render otherwise).
  const key = props.kind === "sync" ? `sync:${props.inSync}` : "live";
  useEffect(() => {
    setOverride(props.kind === "sync" ? { kind: "sync", inSync: props.inSync } : { kind: "live" });
    return () => setOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setOverride]);
  return null;
}

export function HeaderStatusChip() {
  const available = useRealtimeAvailable();
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const { mode } = useHeaderStatus();

  // When the layout deliberately skips the RealtimeProvider (e.g. a
  // compliance-redirected user who can't reach /api/realtime) the chip would
  // otherwise be stuck on "CONNECTING" forever — render nothing.
  if (!available) return null;

  // Connection state is the first half of the chip and is ALWAYS shown:
  // connecting / connected / offline / paused. The sync half (synced/desynced)
  // is appended only when actually connected on a page that pushed sync mode —
  // never show two stale states (offline AND synced doesn't make sense).
  const isConnected = status === "live";
  const connLabel =
    status === "paused"
      ? "paused"
      : status === "offline"
        ? "offline"
        : status === "connecting"
          ? "connecting"
          : "connected";
  const showSync = isConnected && mode.kind === "sync";
  const syncLabel = showSync && mode.kind === "sync" ? (mode.inSync ? "synced" : "desynced") : null;

  // The dot purely reflects connection state. Sync state has its own glyph
  // (<SyncIndicator/>) appended next to the synced/desynced label below — so
  // the dot stays green-pulsing as long as the SSE stream is live, even when
  // a backend is mid-replication.
  const dotClass =
    status === "paused"
      ? "bg-[color:var(--color-fg-subtle)]"
      : status === "offline"
        ? "bg-[color:var(--color-error)]"
        : status === "connecting"
          ? "bg-[color:var(--color-warn)]"
          : "animate-pulse bg-[color:var(--color-success)]";

  const title =
    status === "paused"
      ? "Live updates paused — click to resume"
      : status === "offline"
        ? "Connection lost — auto-retrying"
        : status === "connecting"
          ? "Connecting…"
          : showSync && mode.kind === "sync" && !mode.inSync
            ? "Connected — replication in flight (waiting for AXFR)"
            : showSync
              ? "Connected — all backends in sync"
              : "Connected — live updates streaming";

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase hover:bg-[color:var(--color-bg-subtle)]"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      {connLabel}
      {syncLabel && mode.kind === "sync" ? (
        <>
          <span className="text-[color:var(--color-fg-subtle)]">·</span>
          <SyncIndicator state={mode.inSync ? "synced" : "desynced"} size={14} />
          <span>{syncLabel}</span>
        </>
      ) : null}
    </button>
  );
}
