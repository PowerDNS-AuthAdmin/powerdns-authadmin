"use client";

/**
 * components/ui/flash-listener.tsx
 *
 * Watches the URL for a `flash=<kind>` query param and surfaces a toast,
 * then strips the param from the URL so it doesn't re-fire on refresh.
 *
 * Used by `requireUserForPage()` in `lib/auth/require-user.ts`: when a
 * server component refuses access (forbidden / session-required), it
 * redirects with `?flash=...` instead of rendering an error overlay.
 * This listener turns the redirect into a user-visible toast.
 *
 * Mounted inside `DialogProvider` in `app/(app)/layout.tsx` so the
 * `useDialog()` hook works.
 */

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";

export interface FlashConfig {
  kind: "info" | "success" | "error";
  description: string;
}

export function describeFlash(flash: string, need: string | null): FlashConfig | null {
  switch (flash) {
    case "forbidden":
      return {
        kind: "error",
        description: need
          ? `You don't have permission for that page (missing ${need}).`
          : "You don't have permission to view that page.",
      };
    case "session-required":
      return {
        kind: "info",
        description: "Your session expired - please sign in again.",
      };
    case "polling-required":
      return {
        kind: "error",
        description: need
          ? `This view (${need}) requires PDNS_BACKGROUND_POLLING=true. Set it in your environment and restart the app to enable.`
          : "This view requires PDNS_BACKGROUND_POLLING=true. Set it in your environment and restart the app to enable.",
      };
    default:
      return null;
  }
}

export function FlashListener() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useDialog();
  const fired = useRef<string | null>(null);

  useEffect(() => {
    const flash = params.get("flash");
    if (!flash) {
      // Critical: clear the dedupe key once the URL no longer carries a flash
      // param. Without this, a *second* forbidden click that produces an
      // identical URL would match the stored `fired.current` and silently
      // skip - only a page reload would let it fire again. The toast must
      // fire every time the user hits a forbidden route, so we reset here.
      fired.current = null;
      return;
    }
    // Guard against React Strict Mode's double-invoke for the same firing.
    const key = `${flash}|${params.get("need") ?? ""}|${pathname}`;
    if (fired.current === key) return;
    fired.current = key;

    const config = describeFlash(flash, params.get("need"));
    if (config) toast(config);

    // Strip flash + need from the URL so a refresh doesn't re-toast.
    const next = new URLSearchParams(params.toString());
    next.delete("flash");
    next.delete("need");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [params, pathname, router, toast]);

  return null;
}
