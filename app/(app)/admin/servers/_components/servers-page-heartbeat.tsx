"use client";

/**
 * /admin/servers heartbeat. Pure SSE-driven — no client-side polling.
 *
 * The unified background poller adaptively quickens when it sees any
 * primary↔secondary mismatch (replication in flight) and publishes a
 * `zone.updated` event each time a serial transitions; that event
 * arrives over the app-wide RealtimeProvider stream and triggers one
 * router.refresh() here. No 1 s timer, no per-tick RSC refetch storm.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";

interface Props {
  inSync: boolean;
}

export function ServersPageHeartbeat({ inSync }: Props) {
  const router = useRouter();
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const lastRefreshAt = useRef<number>(0);

  useRealtimeEvent(
    (event) =>
      event.type === "zone.updated" ||
      event.type === "zone.sync.changed" ||
      // A backend going (un)reachable flips its status badge — refresh on the
      // same health nudge the bell uses so the list reflects it without a reload.
      event.type === "health.updated",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  const fastMode = !inSync;

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      title={
        status === "live"
          ? fastMode
            ? "Replication in flight — waiting for AXFR to complete."
            : "Synced — click to pause."
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
            ? fastMode
              ? "animate-pulse bg-[color:var(--color-warn)]"
              : "animate-pulse bg-[color:var(--color-success)]"
            : status === "connecting"
              ? "bg-[color:var(--color-warn)]"
              : status === "paused"
                ? "bg-[color:var(--color-fg-subtle)]"
                : "bg-[color:var(--color-error)]"
        }`}
      />
      {status === "live"
        ? fastMode
          ? "desynced"
          : "synced"
        : status === "connecting"
          ? "connecting"
          : status === "paused"
            ? "paused"
            : "offline"}
    </button>
  );
}
