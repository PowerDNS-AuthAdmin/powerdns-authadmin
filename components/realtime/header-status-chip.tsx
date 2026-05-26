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
import { useRealtimeStatus } from "./realtime-provider";

type Mode = { kind: "live" } | { kind: "sync"; inSync: boolean };
const DEFAULT_MODE: Mode = { kind: "live" };

interface HeaderStatusContextValue {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

const HeaderStatusContext = createContext<HeaderStatusContextValue | null>(null);

export function HeaderStatusProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  return (
    <HeaderStatusContext.Provider value={{ mode, setMode }}>
      {children}
    </HeaderStatusContext.Provider>
  );
}

function useHeaderStatus(): HeaderStatusContextValue {
  return useContext(HeaderStatusContext) ?? { mode: DEFAULT_MODE, setMode: () => undefined };
}

/**
 * Tiny no-UI helper a page mounts to tell the header chip what label/state to
 * show. Resets back to the default "Live" mode on unmount.
 */
export function HeaderStatusMode(props: { kind: "live" } | { kind: "sync"; inSync: boolean }) {
  const { setMode } = useHeaderStatus();
  // Stringify the props so the effect only re-runs when something *actually*
  // changes (object identity changes every render otherwise).
  const key = props.kind === "sync" ? `sync:${props.inSync}` : "live";
  useEffect(() => {
    setMode(props.kind === "sync" ? { kind: "sync", inSync: props.inSync } : { kind: "live" });
    return () => setMode(DEFAULT_MODE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setMode]);
  return null;
}

export function HeaderStatusChip() {
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const { mode } = useHeaderStatus();

  // Map state → { label, dotClass, title }.
  let label: string;
  let dotClass: string;
  let title: string;
  if (status === "paused") {
    label = "paused";
    dotClass = "bg-[color:var(--color-fg-subtle)]";
    title = "Live updates paused — click to resume";
  } else if (status === "offline") {
    label = "offline";
    dotClass = "bg-[color:var(--color-error)]";
    title = "Connection lost — auto-retrying";
  } else if (status === "connecting") {
    label = "connecting";
    dotClass = "bg-[color:var(--color-warn)]";
    title = "Connecting…";
  } else if (mode.kind === "sync") {
    if (mode.inSync) {
      label = "synced";
      dotClass = "animate-pulse bg-[color:var(--color-success)]";
      title = "Synced — click to pause";
    } else {
      label = "desynced";
      dotClass = "animate-pulse bg-[color:var(--color-warn)]";
      title = "Replication in flight — waiting for AXFR to complete";
    }
  } else {
    label = "live";
    dotClass = "animate-pulse bg-[color:var(--color-success)]";
    title = "Live updates streaming — click to pause";
  }

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase hover:bg-[color:var(--color-bg-subtle)]"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      {label}
    </button>
  );
}
