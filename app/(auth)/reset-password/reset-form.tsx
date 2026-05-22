"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";

export function ResetPasswordForm({ token }: { token: string }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (pw.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (pw !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        retryAfterSeconds?: number;
      } | null;
      if (res.status === 429) {
        setError(
          data?.retryAfterSeconds
            ? `Too many requests. Try again in ${data.retryAfterSeconds}s.`
            : "Too many requests.",
        );
        return;
      }
      if (!res.ok) {
        setError(data?.error ?? "Reset failed.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p
          className="rounded border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm"
          role="status"
        >
          Password updated. Sign in with the new password.
        </p>
        <a
          href="/login"
          className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-center text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Sign in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="pw" className="block text-sm font-medium">
          New password
        </label>
        <input
          id="pw"
          type="password"
          autoComplete="new-password"
          required
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
        />
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">Minimum 12 characters.</p>
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
      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={loading}
        className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
      >
        {loading ? "Resetting…" : "Set new password"}
      </button>
    </form>
  );
}
