"use client";

/**
 * Dashboard live-feed indicator — consumes the app-wide
 * RealtimeProvider stream. Refreshes the page whenever an audit row
 * or PDNS request is appended (both feed the dashboard's KPI cards +
 * charts).
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";

const DASHBOARD_TYPES = ["audit.appended", "pdns.request.appended"] as const;

export function DashboardLiveFeed() {
  const router = useRouter();
  const { status, enabled, setEnabled } = useRealtimeStatus();
  const lastRefreshAt = useRef<number>(0);

  useRealtimeEvent(
    (event) => (DASHBOARD_TYPES as readonly string[]).includes(event.type),
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 1_000) return;
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
        ? "live"
        : status === "connecting"
          ? "connecting"
          : status === "paused"
            ? "paused"
            : "offline"}
    </button>
  );
}
