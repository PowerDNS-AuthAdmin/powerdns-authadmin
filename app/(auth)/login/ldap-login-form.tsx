"use client";

/**
 * app/(auth)/login/ldap-login-form.tsx
 *
 * Username + password form for an LDAP provider. Posts to
 * /api/auth/ldap/<slug>/login, which runs the bind-then-search-
 * then-rebind flow server-side. Same captcha contract as the local
 * form — when `turnstileSiteKey` is provided the Cloudflare widget
 * renders and its token is included in the body.
 */

import { useState, type FormEvent } from "react";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

interface Props {
  slug: string;
  providerName: string;
  turnstileSiteKey?: string;
  /** Validated (same-origin) post-login destination. */
  next?: string;
}

export function LdapLoginForm({
  slug,
  providerName,
  turnstileSiteKey,
  next = "/dashboard",
}: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/auth/ldap/${encodeURIComponent(slug)}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          retryAfterSeconds?: number;
          reason?: string;
        } | null;
        if (res.status === 429 && data?.retryAfterSeconds) {
          setError(`Too many attempts. Try again in ${data.retryAfterSeconds}s.`);
        } else if (res.status === 502 && (data?.reason === "transport" || data?.reason === "tls")) {
          setError(
            "We couldn't reach the directory. Try again in a moment, or contact your administrator.",
          );
        } else if (data?.reason === "ldap-not-authorized") {
          setError(
            "Sign-in refused: your account is not authorized for this system. Contact your administrator if you believe this is a mistake.",
          );
        } else if (data?.reason === "captcha-required" || data?.reason === "captcha-failed") {
          setError(
            data.reason === "captcha-required"
              ? "Please complete the captcha challenge."
              : "Captcha verification failed. Try again.",
          );
        } else {
          setError(data?.error ?? "Sign-in failed.");
        }
        setCaptchaResetKey((n) => n + 1);
        return;
      }
      window.location.assign(next);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || (turnstileSiteKey !== undefined && captchaToken === null);

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-label={`Sign in with ${providerName}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{providerName}</span>
        <span className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          LDAP
        </span>
      </div>
      <div>
        <label htmlFor={`ldap-username-${slug}`} className="block text-sm font-medium">
          Username
        </label>
        <input
          id={`ldap-username-${slug}`}
          type="text"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
          placeholder="alice"
        />
      </div>

      <div>
        <label htmlFor={`ldap-password-${slug}`} className="block text-sm font-medium">
          Password
        </label>
        <input
          id={`ldap-password-${slug}`}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
        />
      </div>

      <TurnstileWidget
        siteKey={turnstileSiteKey}
        onToken={setCaptchaToken}
        resetKey={captchaResetKey}
      />

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitDisabled}
        className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
