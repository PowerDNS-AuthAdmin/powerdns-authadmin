"use client";

/**
 * /admin/servers heartbeat. Pure SSE-driven - no client-side polling.
 *
 * The unified background poller adaptively quickens when it sees any
 * primary↔secondary mismatch (replication in flight) and publishes a
 * `zone.updated` event each time a serial transitions; that event arrives
 * over the app-wide RealtimeProvider stream and triggers one router.refresh
 * here. The visible "SYNCED / DESYNCED" chip lives in the shared
 * HeaderStatusChip in the top bar - this component now also pushes the
 * sync state into it via <HeaderStatusMode/>.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { HeaderStatusMode } from "@/components/realtime/header-status-chip";

interface Props {
  inSync: boolean;
}

export function ServersPageHeartbeat({ inSync }: Props) {
  const router = useRouter();
  const lastRefreshAt = useRef<number>(0);

  useRealtimeEvent(
    (event) =>
      event.type === "zone.updated" ||
      event.type === "zone.sync.changed" ||
      // A backend going (un)reachable flips its status badge - refresh on the
      // same health nudge the bell uses so the list reflects it without a reload.
      event.type === "health.updated",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  return <HeaderStatusMode kind="sync" inSync={inSync} />;
}
