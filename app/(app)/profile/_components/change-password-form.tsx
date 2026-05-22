"use client";

/**
 * app/(app)/profile/_components/change-password-form.tsx
 *
 * Three-field form (current, new, confirm) plus an optional captcha
 * widget. Posts to /api/auth/change-password and surfaces per-field
 * errors from the server.
 *
 * Captcha (S-4 follow-up): when `turnstileSiteKey` is provided, the
 * shared <TurnstileWidget> renders the Cloudflare challenge and the
 * form includes its response token in the POST body. The server
 * requires it whenever TURNSTILE_SECRET_KEY is configured.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { TurnstileWidget } from "@/components/ui/turnstile-widget";

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
  retryAfterSeconds?: number;
}

export function ChangePasswordForm({ turnstileSiteKey }: { turnstileSiteKey?: string }) {
  const router = useRouter();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setOk(false);
    setFieldErrors({});

    try {
      const res = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
          ...(captchaToken !== null ? { captchaToken } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ErrorBody | null;
        if (res.status === 429 && data?.retryAfterSeconds) {
          setError(`Too many attempts. Try again in ${data.retryAfterSeconds}s.`);
        } else {
          setError(data?.error ?? "Could not change password.");
        }
        if (data?.details?.fieldErrors) setFieldErrors(data.details.fieldErrors);
        // Token is single-use server-side; refresh the widget.
        setCaptchaResetKey((n) => n + 1);
        return;
      }
      setOk(true);
      setCurrent("");
      setNew("");
      setConfirm("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || (turnstileSiteKey !== undefined && captchaToken === null);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field
        label="Current password"
        id="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrent}
        errors={fieldErrors["currentPassword"]}
      />
      <Field
        label="New password"
        id="newPassword"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={setNew}
        errors={fieldErrors["newPassword"]}
      />
      <Field
        label="Confirm new password"
        id="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={setConfirm}
        errors={fieldErrors["confirmPassword"]}
      />

      <TurnstileWidget
        siteKey={turnstileSiteKey}
        onToken={setCaptchaToken}
        resetKey={captchaResetKey}
      />
      {fieldErrors["captchaToken"]?.length ? (
        <p className="text-xs text-[color:var(--color-error)]" role="alert">
          {fieldErrors["captchaToken"].join(" ")}
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
      {ok ? <p className="text-sm text-[color:var(--color-success)]">Password updated.</p> : null}

      <button
        type="submit"
        disabled={submitDisabled}
        className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
      >
        {loading ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
  errors,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  value: string;
  onChange: (next: string) => void;
  errors?: string[];
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
      />
      {errors && errors.length > 0 ? (
        <p className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
