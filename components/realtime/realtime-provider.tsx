"use client";

/**
 * App-wide realtime context. One <RealtimeProvider> mounted at the
 * authenticated app shell opens a SINGLE EventSource against
 * /api/realtime; everything below it consumes events via the
 * `useRealtimeEvent` hook (one shared dispatcher, no per-component
 * SSE connections).
 *
 * Why: each EventSource is a long-lived HTTP/2 stream + a server-side
 * subscriber. With per-component subscribers we were opening 3–5
 * streams per page (zone indicator, server indicator, audit indicator,
 * pdns-requests indicator, dashboard live feed). One stream is enough
 * - every event we publish goes onto the same bus.
 *
 * Client-side filtering: subscribers pass a predicate that scopes
 * which events trigger their callback. The predicate is recomputed
 * every render so dynamic filtering (e.g. by zone name from the URL)
 * works without extra plumbing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface RealtimeEventBase {
  type: string;
  at?: string;
}
export type RealtimeEvent = RealtimeEventBase & Record<string, unknown>;

type Listener = (event: RealtimeEvent) => void;
type Predicate = (event: RealtimeEvent) => boolean;

/** Public connection status - "offline" only fires after a 5s grace so a fresh
 *  page load (or a transient blip) doesn't flash "offline" before the SSE
 *  stream has even had a chance to open. */
export type RealtimeStatus = "connecting" | "live" | "paused" | "offline";
type RawStatus = "connecting" | "live" | "paused" | "error";

interface ContextValue {
  status: RealtimeStatus;
  /** Toggle the connection (chip click). */
  setEnabled: (enabled: boolean) => void;
  enabled: boolean;
  /** Register a filtered listener; returns an unsubscribe fn. */
  on: (predicate: Predicate, listener: Listener) => () => void;
}

const RealtimeContext = createContext<ContextValue | null>(null);

interface ListenerEntry {
  predicate: Predicate;
  listener: Listener;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  // `raw` is the immediate EventSource state; `status` is the public view that
  // applies a 5 s grace before reporting "offline" - so a Ctrl-R never flashes
  // offline → connecting → live, only connecting → live.
  const [raw, setRaw] = useState<RawStatus>("connecting");
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const listenersRef = useRef<Set<ListenerEntry>>(new Set());

  useEffect(() => {
    if (!enabled) {
      setRaw("paused");
      return;
    }
    const es = new EventSource("/api/realtime", { withCredentials: true });
    setRaw("connecting");
    es.onopen = () => setRaw("live");
    es.onmessage = (e) => {
      const data: unknown = e.data;
      if (typeof data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as RealtimeEvent;
      if (event.type === "ready") {
        setRaw("live");
        return;
      }
      for (const entry of listenersRef.current) {
        try {
          if (entry.predicate(event)) entry.listener(event);
        } catch {
          // a faulty listener must never break the rest
        }
      }
    };
    es.onerror = () => setRaw("error");
    return () => {
      es.close();
    };
  }, [enabled]);

  // Derive the public `status` from `raw` with a 5 s grace before "offline":
  // an erroring connection keeps reading as "connecting" for the first 5 s so a
  // freshly-loaded page (or a transient blip) never flashes "offline".
  useEffect(() => {
    if (raw === "live") {
      setStatus("live");
      return;
    }
    if (raw === "paused") {
      setStatus("paused");
      return;
    }
    if (raw === "connecting") {
      setStatus("connecting");
      return;
    }
    // raw === "error": keep "connecting" for 5 s, then declare "offline".
    setStatus("connecting");
    const t = setTimeout(() => setStatus("offline"), 5000);
    return () => clearTimeout(t);
  }, [raw]);

  const on = useCallback<ContextValue["on"]>((predicate, listener) => {
    const entry: ListenerEntry = { predicate, listener };
    listenersRef.current.add(entry);
    return () => {
      listenersRef.current.delete(entry);
    };
  }, []);

  // Memoize the context value object so consumer effects that depend
  // on `ctx` only re-run when its constituent parts actually change.
  // Without this, every render of the provider gives every
  // `useRealtimeEvent` consumer a new `ctx` reference, causing them
  // to unsubscribe + re-subscribe their listener on EVERY render.
  const value = useMemo<ContextValue>(
    () => ({ status, enabled, setEnabled, on }),
    [status, enabled, on],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/** True iff a RealtimeProvider is mounted above the caller. The header chip
 *  uses this to render nothing when the layout deliberately skips realtime
 *  (e.g. on the must-change-password compliance redirect where /api/realtime
 *  would reject with 403 and the chip would be stuck on "connecting"). */
export function useRealtimeAvailable(): boolean {
  return useContext(RealtimeContext) !== null;
}

export function useRealtimeStatus(): {
  status: RealtimeStatus;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    return {
      status: "connecting",
      enabled: true,
      setEnabled: () => undefined,
    };
  }
  return { status: ctx.status, enabled: ctx.enabled, setEnabled: ctx.setEnabled };
}

/**
 * Register a filtered listener. The predicate runs on every event;
 * matching events call `onEvent`. Both are captured via refs that
 * update every render so closures see the latest props - but the
 * subscription itself is registered exactly ONCE per mount (the
 * effect's only dep is `on`, which is stable across renders via
 * useCallback in the provider). Without that stability, every
 * provider re-render would unsubscribe + re-subscribe every
 * consumer in the tree.
 */
export function useRealtimeEvent(predicate: Predicate, onEvent: Listener): void {
  const ctx = useContext(RealtimeContext);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const predicateRef = useRef(predicate);
  predicateRef.current = predicate;

  const on = ctx?.on;
  useEffect(() => {
    if (!on) return;
    return on(
      (event) => predicateRef.current(event),
      (event) => handlerRef.current(event),
    );
  }, [on]);
}
