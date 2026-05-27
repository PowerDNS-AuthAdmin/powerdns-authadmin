"use client";

/**
 * components/auth/compliance-guard.tsx
 *
 * A non-compliant operator (forced-MFA-not-enrolled, or flagged
 * `mustChangePassword`) is already shunted to /profile by the server gate in
 * `lib/auth/require-user.ts` + `app/(app)/layout.tsx`. Without help, clicking
 * any nav link still triggers a Next.js soft-navigation flash (loading shimmer,
 * URL change, redirect bounce) before the server pulls them back. This guard
 * intercepts those clicks on the client *before* the navigation starts and
 * tells the banner to shake — the operator stays put and the reason is
 * obvious.
 *
 * One guard handles both reasons (MFA-enrollment-required and password-must-
 * change). The banner copy switches on the reason; the shake animation and
 * click-interception behaviour are shared so the two flows feel identical to
 * the operator.
 *
 * Composition:
 *   - <ComplianceGuardProvider mfaRequired={...} passwordChangeRequired={...}/>
 *     wraps the app (mounted in the (app) layout). Owns the two flags + a
 *     shake counter.
 *   - The provider mounts a capture-phase document click handler that no-ops
 *     internal <a> clicks while blocked, except for routes the operator is
 *     allowed to use (/profile + auth APIs + external links).
 *   - <ComplianceBanner/> reads the counter; its key changes on each
 *     blocked attempt, which restarts the CSS animation.
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

export type ComplianceReason = "mfa" | "password";

interface ContextValue {
  /** Set of reasons currently blocking the operator (empty when compliant). */
  reasons: ReadonlySet<ComplianceReason>;
  /** Increments on every blocked-navigation attempt to restart the shake. */
  shakeKey: number;
  triggerShake: () => void;
}

const Ctx = createContext<ContextValue>({
  reasons: new Set(),
  shakeKey: 0,
  triggerShake: () => undefined,
});

/** Paths the operator is allowed to reach while non-compliant. */
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

export function ComplianceGuardProvider({
  mfaRequired,
  passwordChangeRequired,
  children,
}: {
  mfaRequired: boolean;
  passwordChangeRequired: boolean;
  children: ReactNode;
}) {
  const [shakeKey, setShakeKey] = useState(0);
  const triggerShake = useCallback(() => setShakeKey((k) => k + 1), []);

  const reasons = useMemo(() => {
    const set = new Set<ComplianceReason>();
    if (mfaRequired) set.add("mfa");
    if (passwordChangeRequired) set.add("password");
    return set;
  }, [mfaRequired, passwordChangeRequired]);

  const blocked = reasons.size > 0;

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
    () => ({ reasons, shakeKey, triggerShake }),
    [reasons, shakeKey, triggerShake],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComplianceGuard(): ContextValue {
  return useContext(Ctx);
}

/**
 * The orange banner shown on /profile that shakes whenever the guard blocks a
 * nav. Picks copy by reason. When both reasons are active we lead with MFA
 * (matches the server-side priority in `evaluateSessionCompliance`).
 */
export function ComplianceBanner() {
  const { reasons, shakeKey } = useComplianceGuard();
  if (reasons.size === 0) return null;

  const mfa = reasons.has("mfa");
  const password = reasons.has("password");

  let title: string;
  let detail: string;
  if (mfa && password) {
    title = "Two-factor enrollment and password change required.";
    detail = "Enroll TOTP below, then change your password to continue.";
  } else if (mfa) {
    title = "Two-factor enrollment required.";
    detail = "Enroll TOTP below to continue using the app.";
  } else {
    title = "Your password must be changed.";
    detail = "Pick a new one below.";
  }

  return (
    // `key={shakeKey}` re-mounts this node on every blocked attempt, which
    // restarts the CSS animation cleanly (no need to toggle a class).
    <div
      key={shakeKey}
      className="animate-shake rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm"
      role="alert"
    >
      <strong>{title}</strong> {detail}
    </div>
  );
}
