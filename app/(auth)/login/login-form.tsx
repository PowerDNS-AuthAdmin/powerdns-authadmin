"use client";

/**
 * app/(auth)/login/login-form.tsx
 *
 * Client component for the local-auth form. The actual auth happens at
 * /api/auth/login; this component just collects input and renders the
 * server's response.
 *
 * Captcha (S-4): when `turnstileSiteKey` is provided, the shared
 * <TurnstileWidget> renders the Cloudflare challenge and the form
 * includes its response token in the POST body. The server requires
 * a valid token whenever TURNSTILE_SECRET_KEY is configured.
 *
 * Kept as plain controlled components rather than reaching for React Hook
 * Form here — the form has two fields. Add the framework when there are
 * five.
 */

import { useState, type FormEvent } from "react";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

export function LoginForm({
  turnstileSiteKey,
  next = "/dashboard",
}: {
  turnstileSiteKey?: string;
  /** Validated (same-origin) post-login destination — see lib/auth/safe-redirect. */
  next?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  /**
   * MFA second step. When the server returns `mfaRequired`, this holds
   * the single-use challenge token. While non-null, the form swaps
   * email/password inputs for a 6-digit code field.
   */
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function handleMfaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfaChallenge) return;
    if (!/^\d{6}$/.test(code)) {
      setError("Code must be 6 digits.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: mfaChallenge, code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          retryAfterSeconds?: number;
        } | null;
        if (res.status === 429 && data?.retryAfterSeconds) {
          setError(`Too many attempts. Try again in ${data.retryAfterSeconds}s.`);
        } else {
          setError(data?.error ?? "MFA verification failed.");
        }
        // The challenge token was burned server-side on any attempt
        // (right or wrong code). Drop back to the password step so
        // the operator can re-enter and get a fresh challenge.
        setMfaChallenge(null);
        setCode("");
        setPassword("");
        return;
      }
      window.location.assign(next);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          retryAfterSeconds?: number;
          unlockAt?: string;
          reason?: string;
        } | null;
        if (res.status === 429 && data?.unlockAt) {
          setError(`Account locked until ${new Date(data.unlockAt).toLocaleString()}.`);
        } else if (res.status === 429 && data?.retryAfterSeconds) {
          setError(`Too many attempts. Try again in ${data.retryAfterSeconds}s.`);
        } else if (data?.reason === "email-unverified") {
          // Signup-enabled deployments block login until the email is verified.
          setError(
            "Verify your email before signing in. Check your inbox for the verification link (or ask your administrator if email isn't configured).",
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
        // Captcha tokens are single-use server-side; refresh the widget so
        // the user can try again without reloading the page.
        setCaptchaResetKey((n) => n + 1);
        return;
      }

      // The login endpoint either starts a session OR returns
      // `{ mfaRequired, challengeToken }` when TOTP is enrolled. In
      // the MFA case we swap the form into the code-entry step
      // rather than redirecting; the operator submits the code via
      // /api/auth/mfa/totp which then starts the session.
      const data = (await res.json().catch(() => null)) as {
        mfaRequired?: boolean;
        challengeToken?: string;
      } | null;
      if (data?.mfaRequired && data.challengeToken) {
        setMfaChallenge(data.challengeToken);
        setCode("");
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

  // MFA step — rendered after a successful password verify when the
  // user has TOTP enrolled. The challenge token is single-use; if the
  // operator gets the code wrong they fall back to the password step
  // and re-authenticate to get a fresh challenge.
  if (mfaChallenge) {
    return (
      <form onSubmit={handleMfaSubmit} className="space-y-4">
        <div>
          <label htmlFor="mfa-code" className="block text-sm font-medium">
            Authenticator code
          </label>
          <input
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="mt-1 w-32 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-center font-mono text-lg tracking-widest focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
            placeholder="123456"
          />
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            Open your authenticator app and enter the current 6-digit code.
          </p>
        </div>

        {error ? (
          <p className="text-sm text-[color:var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {loading ? "Verifying…" : "Sign in"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
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
