"use client";

/**
 * Zones-list realtime listener. Pure SSE-driven — no client-side polling. The
 * unified server-side poller chains follow-up polls while replication is in
 * flight, so one router.refresh fires per real change, not per 1 s tick.
 *
 * The amalgamated zones list spans every configured backend, so the subscriber
 * listens on a *set* of channel slugs (every primary's slug for primary+
 * secondary topologies, every peer's slug for clusters) and refreshes the page
 * when any of them publishes a zone event.
 *
 * Renders nothing visible: the "SYNCED / DESYNCED" chip lives in the shared
 * HeaderStatusChip in the top bar — we push the page's sync state into it via
 * <HeaderStatusMode/>.
 */

import { useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { HeaderStatusMode } from "@/components/realtime/header-status-chip";

interface Props {
  /** Channel slugs to listen on — see the file header for what counts as a
   *  channel slug for each topology. */
  serverSlugs: string[];
  inSync: boolean;
}

export function ServerRealtimeSubscriber({ serverSlugs, inSync }: Props) {
  const router = useRouter();
  const lastRefreshAt = useRef<number>(0);

  // Sets give O(1) membership for the per-event predicate; rebuilt on the rare
  // occasion the page's backend set changes (a server added / removed).
  const slugSet = useMemo(() => new Set(serverSlugs), [serverSlugs]);

  useRealtimeEvent(
    (event) => {
      if (event.type !== "zone.updated" && event.type !== "zone.sync.changed") return false;
      const slug = event["serverSlug"];
      return typeof slug === "string" && slugSet.has(slug);
    },
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  return <HeaderStatusMode kind="sync" inSync={inSync} />;
}
