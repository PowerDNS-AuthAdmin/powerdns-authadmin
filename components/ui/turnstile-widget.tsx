"use client";

/**
 * components/ui/turnstile-widget.tsx
 *
 * Wraps the Cloudflare Turnstile widget so multiple forms can use it
 * with a single block. Replaces the duplicated copy that used to live
 * inside login-form.tsx and change-password-form.tsx.
 *
 * Usage:
 *   const [token, setToken] = useState<string | null>(null);
 *   const [resetKey, setResetKey] = useState(0);
 *   ...
 *   <TurnstileWidget
 *     siteKey={siteKey}
 *     onToken={setToken}
 *     resetKey={resetKey}
 *   />
 *
 * To reset the widget after a server-side rejection (token is
 * single-use against Cloudflare), bump `resetKey`. The widget will
 * call `onToken(null)` and re-render fresh.
 *
 * Renders nothing when `siteKey` is undefined — keeps the calling
 * form's JSX clean ("captcha-or-nothing" branches stay at the
 * parent level).
 */

import Script from "next/script";
import { useEffect, useId, useRef } from "react";

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__pdaTurnstileOnload&render=explicit";

interface TurnstileGlobal {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
    __pdaTurnstileOnload?: () => void;
  }
}

interface Props {
  /** Cloudflare site key. When undefined the widget renders nothing. */
  siteKey: string | undefined;
  /** Receives the verification token, or `null` when reset/expired/errored. */
  onToken: (token: string | null) => void;
  /**
   * Bump this value to imperatively reset the widget. The widget
   * notifies the parent by calling `onToken(null)` before resetting,
   * so the parent doesn't have to clear its own state separately.
   * Defaults to 0; effectively a no-op when omitted.
   */
  resetKey?: number;
}

export function TurnstileWidget({ siteKey, onToken, resetKey = 0 }: Props) {
  const containerId = useId();
  const widgetIdRef = useRef<string | null>(null);
  // Cache the onToken in a ref so the render effect doesn't tear down
  // and re-render the widget every time the parent re-creates the
  // callback (which would burn a Cloudflare token mint on every parent
  // render — wasteful and visible to the user as a flicker).
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey) return;
    const tryRender = () => {
      if (widgetIdRef.current !== null) return;
      const container = document.getElementById(containerId);
      if (!container || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(container, {
        sitekey: siteKey,
        callback: (t) => onTokenRef.current(t),
        "expired-callback": () => onTokenRef.current(null),
        "error-callback": () => onTokenRef.current(null),
      });
    };
    window.__pdaTurnstileOnload = tryRender;
    tryRender();
  }, [siteKey, containerId]);

  // Reset on demand. Don't fire on the initial render (resetKey
  // starts at 0); only after a parent bump.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (!siteKey) return;
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
      onTokenRef.current(null);
    }
  }, [resetKey, siteKey]);

  if (!siteKey) return null;
  return (
    <>
      <Script src={TURNSTILE_SCRIPT_SRC} strategy="afterInteractive" async defer />
      <div id={containerId} aria-label="Captcha challenge" />
    </>
  );
}
