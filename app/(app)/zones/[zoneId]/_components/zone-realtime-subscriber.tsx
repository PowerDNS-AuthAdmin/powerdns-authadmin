"use client";

/**
 * Zone-detail realtime indicator. Pure SSE-driven via the app-wide
 * RealtimeProvider — no client-side polling.
 *
 * The server-side poller adaptively quickens (chains a follow-up poll
 * every 2.5 s) while any primary↔secondary mismatch is observed, and
 * publishes a `zone.updated` event each time a serial transitions. So
 * the chip flips back to "live" within seconds of AXFR completing
 * with one router.refresh per actual change — no 1 s RSC refetch
 * storm.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";

interface Props {
  zoneName: string;
  inSync: boolean;
}

export function ZoneRealtimeSubscriber({ zoneName, inSync }: Props) {
  const router = useRouter();
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const lastRefreshAt = useRef<number>(0);

  useRealtimeEvent(
    // Match on zone name across ANY backend slug: a derived (ungrouped)
    // secondary's AXFR catch-up is published under its OWN slug, not the
    // primary's, so a serverSlug filter would miss it and the chip would stick.
    (event) => event.type === "zone.updated" && event["zone"] === zoneName,
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
