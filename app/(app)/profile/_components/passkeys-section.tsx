"use client";

/**
 * app/(app)/profile/_components/passkeys-section.tsx
 *
 * Self-service WebAuthn enrolment + per-credential management. Sits next to
 * the TOTP section in the /profile MFA tab. Each enrolled passkey lists
 * its nickname, transports, last-used timestamp, and a remove button.
 *
 * Driven by `@simplewebauthn/browser` - `startRegistration` returns the
 * platform's attestation response which we POST to /registration-verify.
 *
 * The forced-enrolment banner (`mfaRequired` query param) is rendered by
 * the parent <TotpSection /> so we don't double up.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

interface CredentialView {
  id: string;
  nickname: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

interface Props {
  initial: CredentialView[];
  /** When true, the section renders read-only with a "managed upstream" caption. */
  ssoOnly: boolean;
}

export function PasskeysSection({ initial, ssoOnly }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [creds, setCreds] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState<{ nickname: string } | null>(null);

  async function handleStartEnroll(e: FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    const nickname = enrolling.nickname.trim();
    if (nickname.length === 0) {
      toast({ kind: "error", description: "Give the passkey a name." });
      return;
    }
    setBusy(true);
    try {
      const optionsResult = await mutate(`/api/profile/mfa/webauthn/registration-options`, {
        method: "POST",
      });
      if (!optionsResult.ok) {
        toast({
          kind: "error",
          title: "Enrolment failed to start",
          description: optionsResult.error,
        });
        return;
      }
      const { options, challengeToken } = optionsResult.data as {
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeToken: string;
      };

      // The browser/OS handles the platform prompt (Touch ID, Windows
      // Hello, security-key tap). Cancel or hardware fail throws.
      const attestation = await startRegistration({ optionsJSON: options });

      const verify = await mutate(`/api/profile/mfa/webauthn/registration-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken, nickname, response: attestation }),
      });
      if (!verify.ok) {
        toast({ kind: "error", title: "Could not enrol passkey", description: verify.error });
        return;
      }
      const newCred = (verify.data as { credential: CredentialView }).credential;
      setCreds((cur) => [...cur, { ...newCred, lastUsedAt: null }]);
      setEnrolling(null);
      toast({ kind: "success", description: "Passkey enrolled." });
      router.refresh();
    } catch (err) {
      // Most common: user cancelled the platform prompt → throws
      // `NotAllowedError`. Don't toast an error for that.
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError") {
        toast({
          kind: "error",
          title: "Enrolment failed",
          description: err instanceof Error ? err.message : "Unknown error.",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(cred: CredentialView) {
    const ok = await confirm({
      title: `Remove "${cred.nickname}"?`,
      description:
        "This passkey will no longer be able to sign you in. If it's your only MFA factor and your role requires MFA, you'll be sent to forced enrolment on your next request.",
      confirmLabel: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/profile/mfa/webauthn/${encodeURIComponent(cred.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast({ kind: "error", description: "Remove failed." });
        return;
      }
      setCreds((cur) => cur.filter((c) => c.id !== cred.id));
      toast({ kind: "success", description: "Passkey removed." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (ssoOnly) {
    return null; // SSO-only users see the TOTP section's "managed upstream" copy already.
  }

  return (
    <section className="space-y-3 rounded-md border border-[color:var(--color-border)] p-5">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Passkeys & security keys
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          Enrol a passkey (Touch ID, Windows Hello, Android screen lock) or a hardware security key
          (YubiKey, Solo, Titan). They count as a second factor and can also sign you in without a
          password - pick "Sign in with passkey" on the login page.
        </p>
      </header>

      {creds.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No passkeys enrolled yet.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)] rounded border border-[color:var(--color-border)]">
          {creds.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium">{c.nickname}</div>
                <div className="text-xs text-[color:var(--color-fg-muted)]">
                  {c.transports.length > 0 ? c.transports.join(", ") : "unknown transport"}
                  {" · enrolled "}
                  {new Date(c.createdAt).toLocaleDateString()}
                  {c.lastUsedAt
                    ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`
                    : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(c)}
                disabled={busy}
                className="shrink-0 rounded border border-[color:var(--color-error)] px-3 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {enrolling ? (
        <form
          onSubmit={handleStartEnroll}
          className="space-y-2 rounded bg-[color:var(--color-bg-subtle)] p-3"
        >
          <label className="block text-xs font-medium" htmlFor="passkey-nickname">
            Name this passkey
          </label>
          <input
            id="passkey-nickname"
            type="text"
            value={enrolling.nickname}
            onChange={(e) => setEnrolling({ nickname: e.target.value })}
            disabled={busy}
            maxLength={64}
            placeholder="MacBook Touch ID"
            className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEnrolling(null)}
              disabled={busy}
              className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || enrolling.nickname.trim().length === 0}
              className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {busy ? "Waiting for device…" : "Enrol"}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setEnrolling({ nickname: "" })}
          disabled={busy}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          Add a passkey
        </button>
      )}
    </section>
  );
}
