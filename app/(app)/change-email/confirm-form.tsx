"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-fetch";

export function ConfirmEmailChangeForm({ token }: { token: string }) {
  const [status, setStatus] = useState<"confirming" | "done" | "error">("confirming");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const started = useRef(false);

  async function confirm() {
    setStatus("confirming");
    setError(null);
    try {
      const res = await apiFetch("/api/profile/email/change/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Could not confirm email change.");
        setStatus("error");
        return;
      }
      const data = (await res.json()) as { email: string };
      setEmail(data.email);
      setStatus("done");
      // Sessions were revoked server-side — bounce to login with a flash so the
      // user reads the result first. (Leaving (app), so flash beats a toast.)
      setTimeout(() => window.location.assign("/login?flash=email-changed"), 1500);
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  }

  // The link click IS the confirmation — confirm automatically on mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "error") {
    return (
      <div className="space-y-3">
        <p
          className="rounded border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-3 text-sm"
          role="alert"
        >
          {error}
        </p>
        <button
          type="button"
          onClick={() => void confirm()}
          className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Try again
        </button>
      </div>
    );
  }

  if (status === "done") {
    return (
      <p
        className="rounded border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm"
        role="status"
      >
        Email changed to <code>{email}</code>. Sessions revoked — sign in again in a moment.
      </p>
    );
  }

  return (
    <p
      className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-sm"
      role="status"
    >
      Confirming your new email…
    </p>
  );
}
