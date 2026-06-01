"use client";

import { useState, type FormEvent } from "react";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

export function ForgotPasswordForm({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(captchaToken !== null ? { captchaToken } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
        retryAfterSeconds?: number;
      } | null;
      if (res.status === 429) {
        setError(
          data?.retryAfterSeconds
            ? `Too many requests. Try again in ${data.retryAfterSeconds}s.`
            : "Too many requests.",
        );
        // Single-use token; refresh the widget.
        setCaptchaResetKey((n) => n + 1);
        return;
      }
      if (!res.ok) {
        setError(data?.error ?? "Request failed.");
        setCaptchaResetKey((n) => n + 1);
        return;
      }
      setMessage(data?.message ?? "Request received.");
      // The server returns the same opaque OK whether the email
      // matched or not (so this isn't an existence oracle) and
      // whether captcha verified or not (so misconfigured client
      // captchas don't help bots distinguish). Either way, the
      // token is burned upstream - refresh so the user can resubmit.
      setCaptchaResetKey((n) => n + 1);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
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
      <TurnstileWidget
        siteKey={turnstileSiteKey}
        onToken={setCaptchaToken}
        resetKey={captchaResetKey}
      />
      {message ? (
        <p
          className="rounded border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm"
          role="status"
        >
          {message}
        </p>
      ) : null}
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
        {loading ? "Sending…" : "Request reset link"}
      </button>
    </form>
  );
}
