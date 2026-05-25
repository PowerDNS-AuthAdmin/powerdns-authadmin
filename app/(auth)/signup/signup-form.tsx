"use client";

/**
 * app/(auth)/signup/signup-form.tsx
 *
 * Client form for self-service signup. Collects email, password (+ confirm),
 * an optional display name, and the captcha token when configured. Posts to
 * /api/auth/signup, which returns a uniform OK (the body never reveals whether
 * the email already exists), so on success we always render the same
 * "check your email / ask your admin" confirmation.
 *
 * Styling mirrors the login form so the two pages feel like one set.
 */

import { useState, type FormEvent } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/validators/password-policy";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

export function SignupForm({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Client-side mirror of the server policy so users get instant feedback;
    // the server re-validates regardless.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        error?: string;
        retryAfterSeconds?: number;
        reason?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      } | null;

      if (!res.ok) {
        if (res.status === 429 && data?.retryAfterSeconds) {
          setError(`Too many requests. Try again in ${data.retryAfterSeconds}s.`);
        } else if (data?.reason === "captcha-required" || data?.reason === "captcha-failed") {
          setError(
            data.reason === "captcha-required"
              ? "Please complete the captcha challenge."
              : "Captcha verification failed. Try again.",
          );
        } else if (data?.details?.fieldErrors) {
          const first = Object.values(data.details.fieldErrors).flat()[0];
          setError(first ?? data.error ?? "Sign-up failed.");
        } else {
          setError(data?.error ?? "Sign-up failed.");
        }
        // Captcha tokens are single-use server-side; refresh the widget.
        setCaptchaResetKey((n) => n + 1);
        return;
      }

      setDone(data?.message ?? "Thanks for signing up. Check your email to verify your address.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded-md border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm"
      >
        {done}
      </div>
    );
  }

  const submitDisabled = loading || (turnstileSiteKey !== undefined && captchaToken === null);

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
        <label htmlFor="name" className="block text-sm font-medium">
          Name <span className="text-[color:var(--color-fg-muted)]">(optional)</span>
        </label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
        />
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      <div>
        <label htmlFor="confirm" className="block text-sm font-medium">
          Confirm password
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
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
        {loading ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
