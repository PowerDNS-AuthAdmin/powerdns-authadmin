"use client";

/**
 * app/(auth)/login/passkey-button.tsx
 *
 * Primary-credential passkey sign-in. Discoverable-credential flow: the
 * caller doesn't know which user is signing in - the platform shows its
 * own picker, returns an assertion bound to one of the user's resident
 * credentials, and the `/assertion-verify` route maps it back to the
 * owning account and mints the session.
 *
 * The same button-and-handler used to live inside `LoginForm` next to
 * the password fields, but the unified login layout renders every
 * non-local sign-in option as a peer of the local form rather than
 * nested under it - so this lives standalone.
 */

import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";

export function PasskeyButton({ next = "/dashboard" }: { next?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      const optsRes = await fetch("/api/auth/webauthn/assertion-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!optsRes.ok) {
        setError("Could not start passkey sign-in.");
        return;
      }
      const { options, challengeToken } = (await optsRes.json()) as {
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeToken: string;
      };
      const assertion = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch("/api/auth/webauthn/assertion-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeToken,
          mode: "primary",
          response: assertion,
        }),
      });
      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Passkey sign-in failed.");
        return;
      }
      window.location.assign(next);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      // User cancelled the platform picker - quiet failure, no banner.
      if (name !== "NotAllowedError") {
        setError(err instanceof Error ? err.message : "Passkey sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
      >
        <Fingerprint className="h-4 w-4" aria-hidden />
        <span>{busy ? "Waiting for device…" : "Passkey"}</span>
      </button>
      {error ? (
        <p className="text-xs text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
