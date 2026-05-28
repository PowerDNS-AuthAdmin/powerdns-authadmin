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
 * MFA: when the user has TOTP and/or WebAuthn enrolled, the login POST
 * returns `{ mfaRequired, challengeToken, methods }` rather than minting
 * a session. The form swaps to a second-factor step that lets the user
 * pick TOTP code entry OR a WebAuthn assertion (when both are available).
 *
 * Primary passkey login: when `webauthnEnabled` is true the form shows
 * a "Sign in with passkey" button next to the password field. It calls
 * `@simplewebauthn/browser#startAuthentication` with a discoverable-
 * credential request — the platform shows its user picker and the
 * `/assertion-verify` route mints the session without a password.
 */

import { useState, type FormEvent } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

type MfaMethod = "totp" | "webauthn";

export function LoginForm({
  turnstileSiteKey,
  webauthnEnabled,
  next = "/dashboard",
}: {
  turnstileSiteKey?: string;
  /** Whether to show the "Sign in with passkey" button + WebAuthn second-factor option. */
  webauthnEnabled: boolean;
  /** Validated (same-origin) post-login destination — see lib/auth/safe-redirect. */
  next?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  /** MFA second-step state. `mfaToken` is the post-password challenge token. */
  const [mfa, setMfa] = useState<{ mfaToken: string; methods: MfaMethod[] } | null>(null);
  const [mfaMode, setMfaMode] = useState<MfaMethod>("totp");
  const [code, setCode] = useState("");

  async function handleTotpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfa) return;
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
        body: JSON.stringify({ challengeToken: mfa.mfaToken, code }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "MFA verification failed.");
        setMfa(null);
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

  async function handleWebauthnSecondFactor() {
    if (!mfa) return;
    setLoading(true);
    setError(null);
    try {
      // First call: mint an assertion challenge. Pass the email so
      // `allowCredentials` is scoped to this user (the email was
      // already authenticated by the prior password POST).
      const optsRes = await fetch("/api/auth/webauthn/assertion-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!optsRes.ok) {
        setError("Could not start passkey verification.");
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
          mfaToken: mfa.mfaToken,
          mode: "second-factor",
          response: assertion,
        }),
      });
      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Passkey verification failed.");
        // Both tokens are burned server-side; fall back to password step.
        setMfa(null);
        setPassword("");
        return;
      }
      window.location.assign(next);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError") {
        setError(err instanceof Error ? err.message : "Passkey verification failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handlePasskeyPrimary() {
    setPasskeyBusy(true);
    setError(null);
    try {
      // Discoverable-credential flow: no email; the platform picks one
      // of the user's resident credentials and the verify route maps
      // it back to the owning account.
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
        setError(data?.error ?? "Sign-in failed.");
        return;
      }
      window.location.assign(next);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError") {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
      }
    } finally {
      setPasskeyBusy(false);
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
        setCaptchaResetKey((n) => n + 1);
        return;
      }

      // The login endpoint either starts a session OR returns
      // `{ mfaRequired, challengeToken, methods }` when the user has
      // TOTP and/or WebAuthn enrolled. In the MFA case we swap the
      // form into the second-factor step.
      const data = (await res.json().catch(() => null)) as {
        mfaRequired?: boolean;
        challengeToken?: string;
        methods?: MfaMethod[];
      } | null;
      if (data?.mfaRequired && data.challengeToken && data.methods?.length) {
        setMfa({ mfaToken: data.challengeToken, methods: data.methods });
        // Prefer TOTP when both are available (faster for most operators);
        // fall back to whichever is present otherwise.
        setMfaMode(data.methods.includes("totp") ? "totp" : "webauthn");
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
  // user has any factor enrolled. The challenge tokens are single-use;
  // any failed verification drops back to the password step.
  if (mfa) {
    return (
      <div className="space-y-4">
        {mfa.methods.length > 1 ? (
          <div className="flex gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-1 text-xs">
            <button
              type="button"
              onClick={() => setMfaMode("totp")}
              className={`flex-1 rounded px-3 py-1.5 ${
                mfaMode === "totp"
                  ? "bg-[color:var(--color-bg)] font-medium"
                  : "text-[color:var(--color-fg-muted)]"
              }`}
            >
              Authenticator code
            </button>
            <button
              type="button"
              onClick={() => setMfaMode("webauthn")}
              className={`flex-1 rounded px-3 py-1.5 ${
                mfaMode === "webauthn"
                  ? "bg-[color:var(--color-bg)] font-medium"
                  : "text-[color:var(--color-fg-muted)]"
              }`}
            >
              Passkey
            </button>
          </div>
        ) : null}

        {mfaMode === "totp" && mfa.methods.includes("totp") ? (
          <form onSubmit={handleTotpSubmit} className="space-y-4">
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
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              Use your passkey or security key to complete sign-in.
            </p>
            {error ? (
              <p className="text-sm text-[color:var(--color-error)]" role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              onClick={handleWebauthnSecondFactor}
              disabled={loading}
              className="block w-full rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {loading ? "Waiting for device…" : "Continue with passkey"}
            </button>
          </div>
        )}
      </div>
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

      {webauthnEnabled ? (
        <>
          <div className="my-2 flex items-center gap-3 text-xs text-[color:var(--color-fg-subtle)]">
            <span className="h-px flex-1 bg-[color:var(--color-border)]" />
            <span>or</span>
            <span className="h-px flex-1 bg-[color:var(--color-border)]" />
          </div>
          <button
            type="button"
            onClick={handlePasskeyPrimary}
            disabled={passkeyBusy || loading}
            className="block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
          >
            {passkeyBusy ? "Waiting for device…" : "Sign in with passkey"}
          </button>
        </>
      ) : null}
    </form>
  );
}
