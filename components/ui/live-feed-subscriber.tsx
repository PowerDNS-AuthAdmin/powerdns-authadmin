"use client";

/**
 * Live-feed event subscriber. Subscribes to the app-wide RealtimeProvider
 * stream (one EventSource for the whole app) and triggers router.refresh()
 * whenever an event matching `eventTypes` lands. Coalesces refresh-bursts to
 * one per 500 ms.
 *
 * Renders nothing - the visible "LIVE" chip moved to the shared
 * HeaderStatusChip in the top bar, so every page surfaces realtime status in
 * one consistent spot.
 */

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import type { RealtimeEvent } from "@/components/realtime/realtime-provider";

interface Props {
  /** Restrict to these event types - refresh fires only on matches. */
  eventTypes?: readonly string[];
  /** Optional callback fired on every matching event. */
  onEvent?: (event: RealtimeEvent) => void;
}

export function LiveFeedSubscriber({ eventTypes, onEvent }: Props) {
  const router = useRouter();
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

  return null;
}
