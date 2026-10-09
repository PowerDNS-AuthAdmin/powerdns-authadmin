"use client";

/**
 * components/ui/use-unsaved-changes-guard.ts
 *
 * Asks the browser to confirm before the tab is closed, reloaded or
 * navigated away from (a typed URL, a bookmark) while a panel has edits the
 * operator hasn't saved. The settings panels track `dirty` already; this
 * turns that flag into the browser's native "Leave site?" prompt.
 *
 * Only `beforeunload` is wired. In-app navigation through the Next.js router
 * is deliberately left alone: a modal confirm on every sidebar click is the
 * kind of interruption the rest of the app avoids, and the panels re-render
 * from server state on return, so the loss is visible rather than silent.
 */

import { useEffect } from "react";

export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      // Browsers ignore custom text now; preventDefault is what triggers the
      // prompt, `returnValue` is the legacy spelling older engines need.
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
