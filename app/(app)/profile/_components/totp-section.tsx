"use client";

/**
 * app/(app)/profile/_components/totp-section.tsx
 *
 * Self-service TOTP enrollment / removal. Shows the QR code rendered
 * inline as SVG (scanned by the authenticator app's camera) plus the
 * raw base32 secret for the "enter setup key manually" fallback.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

interface Props {
  initialEnabled: boolean;
  /**
   * When true, render a forced-enrollment banner above the section.
   * The layout sets `?mfa-required=1` on its redirect when the
   * operator's role(s) require MFA but they're not enrolled.
   */
  mfaRequired?: boolean;
  /** Slugs of roles that triggered the requirement (for the banner copy). */
  requiringRoleSlugs?: string[];
  /**
   * When true, the user has no local password and only signs in via
   * an IdP — MFA is the IdP's responsibility. The section renders
   * read-only with a "managed upstream" caption; no enroll button,
   * no disable button, no forced-enrollment banner.
   */
  ssoOnly?: boolean;
}

export function TotpSection({
  initialEnabled,
  mfaRequired = false,
  requiringRoleSlugs = [],
  ssoOnly = false,
}: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [enrolling, setEnrolling] = useState<{
    uri: string;
    qrSvg: string;
    secret: string;
    revealToken: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    setBusy(true);
    try {
      const result = await mutate(`/api/profile/mfa/totp`, { method: "POST" });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Enrollment failed",
          description: result.error,
        });
        return;
      }
      const data = result.data as {
        uri: string;
        qrSvg: string;
        secret: string;
        revealToken: string;
      };
      setEnrolling({
        uri: data.uri,
        qrSvg: data.qrSvg,
        secret: data.secret,
        revealToken: data.revealToken,
      });
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!enrolling) return;
    if (!/^\d{6}$/.test(code)) {
      toast({ kind: "error", description: "Code must be 6 digits." });
      return;
    }
    setBusy(true);
    try {
      const result = await mutate(`/api/profile/mfa/totp`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revealToken: enrolling.revealToken, code }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Confirm failed",
          description: result.error,
        });
        // On a wrong code the reveal store burned the secret — the
        // operator has to start over. Clear the form to make that
        // obvious.
        setEnrolling(null);
        return;
      }
      toast({ kind: "success", description: "TOTP enabled." });
      setEnrolling(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    const ok = await confirm({
      title: "Disable TOTP?",
      description:
        "Two-factor authentication will be removed from your account. You'll only need your password to sign in until you re-enroll.",
      confirmLabel: "Disable",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/profile/mfa/totp`, { method: "DELETE" });
      if (!res.ok) {
        toast({ kind: "error", description: "Disable failed." });
        return;
      }
      toast({ kind: "success", description: "TOTP disabled." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Banner shown when the layout shunted the operator here because
  // their role(s) demand MFA. Stays visible until enrolled (the layout
  // stops adding the query param once the user has TOTP enrolled).
  // Suppressed for SSO-only users — the IdP is the second-factor
  // authority for them, so we don't double-prompt.
  const showRequiredBanner = mfaRequired && !initialEnabled && !ssoOnly;

  // SSO-only escape hatch: render a read-only section explaining
  // that MFA is handled upstream. No enroll button, no disable
  // button, no QR. Keeps the section visible at /profile#mfa for
  // discoverability but makes clear that the operator can't (and
  // doesn't need to) act on it here.
  if (ssoOnly) {
    return (
      <section className="space-y-2 rounded-md border border-[color:var(--color-border)] p-5 opacity-80">
        <header>
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Two-factor authentication (TOTP)
          </h2>
        </header>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          <span className="font-medium text-[color:var(--color-fg)]">
            Managed by your identity provider.
          </span>{" "}
          You sign in via SSO, so the IdP (Authentik / Keycloak / Okta / Google) handles two-factor
          authentication. Enroll TOTP, passkeys, or hardware keys in your IdP&apos;s
          account-security settings instead.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-[color:var(--color-border)] p-5">
      {showRequiredBanner ? (
        <div className="mb-1 rounded border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm">
          <strong>MFA enrollment required.</strong>{" "}
          <span className="text-[color:var(--color-fg-muted)]">
            {requiringRoleSlugs.length > 0
              ? `Your role(s) ${requiringRoleSlugs.join(", ")} require two-factor authentication. `
              : "Your role(s) require two-factor authentication. "}
            Enroll below to continue using the app.
          </span>
        </div>
      ) : null}
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Two-factor authentication (TOTP)
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          When enabled, you'll enter a 6-digit code from your authenticator app after your password
          on sign-in.
        </p>
      </header>

      {initialEnabled ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[color:var(--color-success)]">Enabled</span>
          <button
            type="button"
            onClick={handleDisable}
            disabled={busy}
            className="rounded border border-[color:var(--color-error)] px-3 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
          >
            Disable
          </button>
        </div>
      ) : enrolling ? (
        <div className="space-y-3">
          <div className="space-y-3 rounded bg-[color:var(--color-bg-subtle)] p-3">
            <p className="text-xs font-medium">Scan with your authenticator app</p>
            <div className="flex flex-col items-start gap-4 sm:flex-row">
              <div
                className="shrink-0 rounded-md bg-white p-3"
                aria-label="TOTP enrollment QR code"
                // SVG produced server-side by `qrcode` from a URI WE
                // generated — no user-controlled content, so the
                // dangerouslySetInnerHTML is safe.
                dangerouslySetInnerHTML={{ __html: enrolling.qrSvg }}
                style={{ width: 200, height: 200 }}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
                  Open Google Authenticator / 1Password / Authy / Bitwarden and scan the QR. Or, if
                  scanning isn&apos;t possible, type the setup key into the app&apos;s &quot;enter
                  manually&quot; flow:
                </p>
                <code className="block rounded bg-[color:var(--color-bg)] p-2 font-mono text-[0.6875rem] tracking-wider break-all">
                  {enrolling.secret}
                </code>
                <p className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
                  On a mobile browser you can also{" "}
                  <a href={enrolling.uri} className="underline">
                    tap here to open the authenticator app
                  </a>{" "}
                  directly.
                </p>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="totp-code" className="block text-xs font-medium">
              Verify
            </label>
            <input
              id="totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="mt-1 w-32 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-center font-mono text-lg tracking-widest"
              placeholder="123456"
              autoFocus
            />
          </div>
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
              type="button"
              onClick={handleConfirm}
              disabled={busy || code.length !== 6}
              className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Enable"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleStart}
          disabled={busy}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Starting…" : "Enable TOTP"}
        </button>
      )}
    </section>
  );
}
