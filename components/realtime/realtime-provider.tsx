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
import { READY_STATE, shouldReopen, WATCHDOG_MS } from "./reconnect-policy";

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
  // Bumping `generation` discards the current EventSource and opens a new one.
  // The browser's own retry is not enough: a tab Safari froze comes back with a
  // stream that is dead but never errors, or stuck in CONNECTING for good.
  const [generation, setGeneration] = useState(0);
  const lastSeenRef = useRef(Date.now());
  const lastHealthyRef = useRef<number | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const openedAtRef = useRef(Date.now());

  const dispatch = useCallback((event: RealtimeEvent) => {
    for (const entry of listenersRef.current) {
      try {
        if (entry.predicate(event)) entry.listener(event);
      } catch {
        // a faulty listener must never break the rest
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setRaw("paused");
      return;
    }
    const es = new EventSource("/api/realtime", { withCredentials: true });
    sourceRef.current = es;
    openedAtRef.current = Date.now();
    lastSeenRef.current = Date.now();
    setRaw("connecting");
    const markHealthy = () => {
      const now = Date.now();
      lastSeenRef.current = now;
      // A gap means a reopen after silence: tell pages to refetch what they
      // missed. The very first connection of a page load is not a gap.
      const previous = lastHealthyRef.current;
      if (previous !== null && generation > 0 && now - previous > WATCHDOG_MS) {
        dispatch({
          type: "realtime.reconnected",
          at: new Date(now).toISOString(),
          gapMs: now - previous,
        });
      }
      lastHealthyRef.current = now;
      setRaw("live");
    };
    es.onopen = markHealthy;
    es.onmessage = (e) => {
      lastSeenRef.current = Date.now();
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
        markHealthy();
        return;
      }
      if (event.type === "heartbeat") {
        lastHealthyRef.current = Date.now();
        return;
      }
      dispatch(event);
    };
    es.onerror = () => setRaw("error");
    return () => {
      es.close();
      if (sourceRef.current === es) sourceRef.current = null;
    };
  }, [enabled, generation, dispatch]);

  // Watchdog: reopen a stream that is closed, stuck connecting, or silent past
  // two heartbeats. Runs on a timer while the tab is visible and immediately on
  // the events that follow a sleep (tab shown, window focused, network back,
  // page restored from the back-forward cache), so the chip recovers within a
  // few seconds of the operator coming back - without reloading the page.
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      const es = sourceRef.current;
      const observation = {
        readyState: es ? es.readyState : READY_STATE.CLOSED,
        lastSeenAt: lastSeenRef.current,
        openedAt: openedAtRef.current,
        now: Date.now(),
      };
      if (shouldReopen(observation)) {
        // Reset the clocks so one stall triggers one reopen, not one per tick.
        openedAtRef.current = observation.now;
        lastSeenRef.current = observation.now;
        setGeneration((g) => g + 1);
      }
    };
    const timer = setInterval(check, WATCHDOG_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    window.addEventListener("pageshow", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      window.removeEventListener("pageshow", check);
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
