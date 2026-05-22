"use client";

/**
 * Live-feed indicator chip. Subscribes to the app-wide RealtimeProvider
 * stream (one EventSource for the whole app) and triggers
 * router.refresh() whenever an event matching `eventTypes` lands.
 * Coalesces refresh-bursts to one per 500 ms.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import type { RealtimeEvent } from "@/components/realtime/realtime-provider";

interface Props {
  /** Compact label shown next to the dot. Defaults to "live". */
  label?: string;
  /** Restrict to these event types — refresh fires only on matches. */
  eventTypes?: readonly string[];
  /** Optional callback fired on every matching event. */
  onEvent?: (event: RealtimeEvent) => void;
}

export function LiveFeedSubscriber({ label, eventTypes, onEvent }: Props) {
  const router = useRouter();
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const lastRefreshAt = useRef<number>(0);

  useRealtimeEvent(
    (event) => (eventTypes ? eventTypes.includes(event.type) : true),
    (event) => {
      if (onEvent) onEvent(event);
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      title={
        status === "live"
          ? "Live updates streaming — click to pause"
          : status === "paused"
            ? "Live updates paused — click to resume"
            : status === "connecting"
              ? "Connecting…"
              : "Connection lost — auto-retrying"
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase hover:bg-[color:var(--color-bg-subtle)]"
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          status === "live"
            ? "animate-pulse bg-[color:var(--color-success)]"
            : status === "connecting"
              ? "bg-[color:var(--color-warn)]"
              : status === "paused"
                ? "bg-[color:var(--color-fg-subtle)]"
                : "bg-[color:var(--color-error)]"
        }`}
      />
      {status === "live"
        ? (label ?? "live")
        : status === "connecting"
          ? "connecting"
          : status === "paused"
            ? "paused"
            : "offline"}
    </button>
  );
}
