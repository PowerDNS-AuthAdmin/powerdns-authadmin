"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client/api-fetch";
import { useDialog } from "@/components/ui/dialog";

export function VerifyEmailForm({ token }: { token: string }) {
  const router = useRouter();
  const { toast } = useDialog();
  const [status, setStatus] = useState<"verifying" | "done" | "error">("verifying");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function confirm() {
    setStatus("verifying");
    setError(null);
    const res = await apiFetch("/api/auth/email/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      retryAfterSeconds?: number;
    } | null;
    if (!res.ok) {
      setError(
        res.status === 429 && data?.retryAfterSeconds
          ? `Too many requests. Try again in ${data.retryAfterSeconds}s.`
          : (data?.error ?? "Verification failed."),
      );
      setStatus("error");
      return;
    }
    setStatus("done");
    toast({
      kind: "success",
      title: "Email verified",
      description: "Your email address is confirmed. Sign in to continue.",
    });
    // The page is public (logged-out signup users land here), so send them
    // to the sign-in form rather than a session-gated dashboard. A
    // logged-in operator who re-verifies can sign in again at no cost.
    setTimeout(() => router.push("/login"), 1200);
  }

  // The link click IS the confirmation — verify automatically on mount, with
  // no second button to press. The ref guards against React's double-invoke.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "error") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
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

  return (
    <p
      className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-sm"
      role="status"
    >
      {status === "done" ? "Email verified — redirecting to sign in…" : "Verifying your email…"}
    </p>
  );
}
