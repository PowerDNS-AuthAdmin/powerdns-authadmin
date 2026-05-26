"use client";

/**
 * app/(app)/zones/[zoneId]/_components/scroll-to-tab.tsx
 *
 * Mobile UX fix: when the URL carries `?tab=...` (e.g. arriving on the
 * change-history tab via a deep link or clicking a tab from the bottom of
 * a long records list), the zone header above the tabs can push the tab
 * body below the fold on a phone viewport. This tiny client component
 * watches the `tab` searchParam and scrolls the named anchor into view
 * each time it changes — including the initial mount.
 *
 * Default tab ("records", no `tab=` query) is the page's natural landing
 * state, so we deliberately skip scrolling there to preserve the
 * scroll position users had before clicking Records.
 */

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function ScrollToTab({ anchorId }: { anchorId: string }) {
  const sp = useSearchParams();
  const tab = sp.get("tab");
  useEffect(() => {
    if (!tab) return;
    const el = document.getElementById(anchorId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [tab, anchorId]);
  return null;
}
