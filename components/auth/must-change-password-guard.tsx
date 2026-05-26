"use client";

/**
 * components/auth/must-change-password-guard.tsx
 *
 * When the operator must change their password, they're already shunted to
 * /profile by the server (`requireUserForPage`). Without help, clicking any nav
 * link still triggers a Next.js soft-navigation flash (loading shimmer, URL
 * change, redirect bounce) before the server pulls them back. This guard
 * intercepts those clicks on the client *before* the navigation starts and
 * tells the banner to shake — so the operator stays put and the reason is
 * obvious.
 *
 * Composition:
 *   - <MustChangePasswordProvider blocked={...}/> wraps the app (mounted in
 *     the (app) layout). Owns the "blocked" flag + a shake counter.
 *   - The provider mounts a capture-phase document click handler that no-ops
 *     internal <a> clicks while blocked, except for routes the operator is
 *     allowed to use (/profile + auth APIs + external links).
 *   - <MustChangePasswordBanner/> reads the counter; its key changes on each
 *     blocked attempt, which restarts the shake animation.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ContextValue {
  blocked: boolean;
  shakeKey: number;
  triggerShake: () => void;
}

const Ctx = createContext<ContextValue>({
  blocked: false,
  shakeKey: 0,
  triggerShake: () => undefined,
});

/** Paths the operator is allowed to reach while their password is forced. */
const ALLOW_PREFIXES = ["/profile", "/api/profile/", "/api/auth/", "/login", "/logout"];

function isAllowedHref(href: string): boolean {
  // External links + anchors aren't navigation we should block.
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") ||
    href === ""
  ) {
    return true;
  }
  return ALLOW_PREFIXES.some(
    (p) => href === p || href.startsWith(`${p}?`) || href.startsWith(`${p}/`),
  );
}

export function MustChangePasswordProvider({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}) {
  const [shakeKey, setShakeKey] = useState(0);
  const triggerShake = useCallback(() => setShakeKey((k) => k + 1), []);

  // Capture-phase click interceptor: catches both <a href> and Next's <Link>
  // (which renders an <a> too) before its own handler runs. Pointer/key
  // navigations land here too (browser fires a synthetic click).
  useEffect(() => {
    if (!blocked) return;
    function onClick(e: MouseEvent) {
      // Honor modified clicks (open in new tab) — those go to a fresh server
      // page and our `requireUserForPage` gate handles them server-side.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const anchor = (e.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (isAllowedHref(href)) return;
      e.preventDefault();
      e.stopPropagation();
      triggerShake();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [blocked, triggerShake]);

  const value = useMemo<ContextValue>(
    () => ({ blocked, shakeKey, triggerShake }),
    [blocked, shakeKey, triggerShake],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMustChangePassword(): ContextValue {
  return useContext(Ctx);
}

/** The orange banner on /profile that shakes whenever the guard blocks a nav. */
export function MustChangePasswordBanner() {
  const { blocked, shakeKey } = useMustChangePassword();
  if (!blocked) return null;
  return (
    // `key={shakeKey}` re-mounts this node on every blocked attempt, which
    // restarts the CSS animation cleanly (no need to toggle a class).
    <div
      key={shakeKey}
      className="animate-shake rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm"
      role="alert"
    >
      <strong>Your password must be changed.</strong> Pick a new one below.
    </div>
  );
}
