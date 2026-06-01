"use client";

/**
 * Zone-detail realtime listener. Pure SSE-driven via the app-wide
 * RealtimeProvider - no client-side polling.
 *
 * The server-side poller adaptively quickens (chains a follow-up poll every
 * 2.5 s) while any primary↔secondary mismatch is observed, and publishes a
 * `zone.updated` event each time a serial transitions. So the page refreshes
 * within seconds of AXFR completing - one router.refresh per actual change.
 *
 * Renders nothing visible: the "SYNCED / DESYNCED" chip lives in the shared
 * HeaderStatusChip in the top bar - we push the per-zone sync state into it
 * via <HeaderStatusMode/>.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { HeaderStatusMode } from "@/components/realtime/header-status-chip";

interface Props {
  zoneName: string;
  /**
   * Cached primary↔secondaries sync verdict, OR `null` when
   * `PDNS_BACKGROUND_POLLING=false` - there is no live mirror state to
   * push, so the header chip stays in plain "Live" mode. The mutation-driven
   * router.refresh below still fires either way.
   */
  inSync: boolean | null;
}

export function ZoneRealtimeSubscriber({ zoneName, inSync }: Props) {
  const router = useRouter();
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

  if (inSync === null) return null;
  return <HeaderStatusMode kind="sync" inSync={inSync} />;
}
