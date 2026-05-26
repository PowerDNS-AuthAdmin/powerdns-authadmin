"use client";

/**
 * Dashboard live-feed listener — refreshes the page whenever an audit row or
 * PDNS request is appended (both feed the dashboard's KPI cards + charts).
 *
 * Renders nothing: the visible "LIVE" chip moved to the shared HeaderStatusChip
 * in the top bar. This component is purely the SSE event subscriber now; the
 * dashboard is "live" by default in the header chip so no mode-setter is needed.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";

const DASHBOARD_TYPES = ["audit.appended", "pdns.request.appended"] as const;

export function DashboardLiveFeed() {
  const router = useRouter();
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

  return null;
}
