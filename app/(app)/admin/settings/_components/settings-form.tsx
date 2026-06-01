"use client";

/**
 * app/(app)/admin/settings/_components/settings-form.tsx
 *
 * Form for the runtime-mutable settings. Each field maps 1:1 to a key in
 * `KNOWN_SETTING_KEYS`; an empty input deletes the row (PATCH with `null`).
 */

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client/api-fetch";

interface SettingsFormProps {
  initial: {
    site_name: string;
    brand_logo_url: string;
    support_contact: string;
    login_intro: string;
    login_lockout_threshold: number;
    login_lockout_seconds: number;
    allow_password_reset: boolean;
  };
  canWrite: boolean;
}

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

/** Hard cap matches `MAX_BRAND_LOGO_LENGTH` in lib/validators/settings.ts. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/svg+xml",
  "image/webp",
]);

export function SettingsForm({ initial, canWrite }: SettingsFormProps) {
  const router = useRouter();
  const [siteName, setSiteName] = useState(initial.site_name);
  const [brandLogoUrl, setBrandLogoUrl] = useState(initial.brand_logo_url);
  const [supportContact, setSupportContact] = useState(initial.support_contact);
  const [loginIntro, setLoginIntro] = useState(initial.login_intro);
  const [lockoutThreshold, setLockoutThreshold] = useState(String(initial.login_lockout_threshold));
  const [lockoutSeconds, setLockoutSeconds] = useState(String(initial.login_lockout_seconds));
  const [allowPasswordReset, setAllowPasswordReset] = useState(initial.allow_password_reset);

  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * File → base64 data URI, set as the brand logo URL value. The reader runs
   * client-side; the file never leaves the browser until the operator saves.
   */
  async function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    if (!ALLOWED_MIME.has(file.type)) {
      setUploadError(
        `Unsupported file type "${file.type || "unknown"}". Use PNG, JPEG, GIF, SVG, or WebP.`,
      );
      event.target.value = "";
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setUploadError(
        `File is ${(file.size / (1024 * 1024)).toFixed(2)} MB; the maximum is ${(MAX_LOGO_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
      );
      event.target.value = "";
      return;
    }

    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          // readAsDataURL always produces a string per the FileReader
          // contract; the union with ArrayBuffer covers readAsArrayBuffer.
          // Narrow explicitly so the lint rule sees a string, not the
          // generic union (which would stringify objects as
          // "[object Object]").
          const result = reader.result;
          if (typeof result === "string") resolve(result);
          else reject(new Error("FileReader returned a non-string result."));
        };
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(file);
      });
      setBrandLogoUrl(dataUri);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not read the file.");
    } finally {
      // Allow re-selecting the same file later (browsers suppress change
      // events for the same value).
      event.target.value = "";
    }
  }

  function clearLogo() {
    setBrandLogoUrl("");
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setOk(false);
    setError(null);
    setFieldErrors({});

    // Empty string → null (delete the row → fall back to default).
    // Numeric fields parse the input string; NaN → null so a bogus
    // edit doesn't poison the server. The server's Zod schema will
    // reject out-of-range values with a field error too.
    const parsedThreshold = Number.parseInt(lockoutThreshold, 10);
    const parsedSeconds = Number.parseInt(lockoutSeconds, 10);
    const body = {
      site_name: siteName === "" ? null : siteName,
      brand_logo_url: brandLogoUrl === "" ? null : brandLogoUrl,
      support_contact: supportContact === "" ? null : supportContact,
      login_intro: loginIntro === "" ? null : loginIntro,
      login_lockout_threshold: Number.isFinite(parsedThreshold) ? parsedThreshold : null,
      login_lockout_seconds: Number.isFinite(parsedSeconds) ? parsedSeconds : null,
      allow_password_reset: allowPasswordReset,
    };

    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ErrorBody | null;
        setError(data?.error ?? "Save failed.");
        if (data?.details?.fieldErrors) setFieldErrors(data.details.fieldErrors);
        return;
      }
      setOk(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    // autoComplete="off" suppresses the browser/keychain autofill popup
    // ("No items to show / + New identity") that fires on the support_contact
    // field - these aren't credentials.
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-5">
      <Field
        id="site_name"
        label="Site name"
        hint="Shown in the browser tab and the wordmark. Default: 'PowerDNS-AuthAdmin'."
        errors={fieldErrors["site_name"]}
      >
        <input
          id="site_name"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
          disabled={!canWrite}
          autoComplete="off"
          placeholder="PowerDNS-AuthAdmin"
          className={inputClass}
        />
      </Field>

      <Field
        id="brand_logo_url"
        label="Brand logo"
        hint="Paste an absolute URL or upload an image (PNG, JPEG, GIF, SVG, WebP - up to 2 MB). Uploaded images are stored inline as base64. Empty to use the default wordmark."
        errors={fieldErrors["brand_logo_url"]}
      >
        <input
          id="brand_logo_url"
          value={brandLogoUrl}
          onChange={(e) => setBrandLogoUrl(e.target.value)}
          disabled={!canWrite}
          autoComplete="off"
          placeholder="https://example.com/logo.svg"
          className={inputClass}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-bg-muted)] ${canWrite ? "" : "pointer-events-none opacity-60"}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
              onChange={handleFileSelect}
              disabled={!canWrite}
              className="sr-only"
            />
            Upload image
          </label>
          {brandLogoUrl ? (
            <button
              type="button"
              onClick={clearLogo}
              disabled={!canWrite}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-60"
            >
              Clear
            </button>
          ) : null}
        </div>
        {uploadError ? (
          <p className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
            {uploadError}
          </p>
        ) : null}

        {/*
          Live preview. Mirrors the sidebar slot (224 × 40 with overflow:hidden)
          and the auth-layout banner so the operator can see how the logo will
          crop in both contexts before saving. Wrapper backgrounds use the same
          tokens as the actual chromes - dark sidebar in the (app) shell,
          neutral subtle panel in the (auth) shell.
        */}
        <p className="mt-4 text-xs font-medium tracking-wide text-[color:var(--color-fg-subtle)] uppercase">
          Preview
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <PreviewSlot label="Sidebar header (224 × 40)" widthPx={224} heightPx={40}>
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brandLogoUrl}
                alt="Brand logo preview"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <span className="text-xs text-[color:var(--color-fg-subtle)]">
                (default wordmark)
              </span>
            )}
          </PreviewSlot>
          <PreviewSlot label="Sign-in banner (max 240 wide)" widthPx={240} heightPx={80}>
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brandLogoUrl}
                alt="Brand logo preview"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <span className="text-xs text-[color:var(--color-fg-subtle)]">
                (default wordmark)
              </span>
            )}
          </PreviewSlot>
        </div>
      </Field>

      <Field
        id="support_contact"
        label="Support contact"
        hint="Free-form text or URL shown on the login page footer. Email or chat link work."
        errors={fieldErrors["support_contact"]}
      >
        <input
          id="support_contact"
          value={supportContact}
          onChange={(e) => setSupportContact(e.target.value)}
          disabled={!canWrite}
          autoComplete="off"
          placeholder="support@example.com"
          className={inputClass}
        />
      </Field>

      <Field
        id="login_intro"
        label="Login intro text"
        hint="Optional banner text shown above the sign-in form."
        errors={fieldErrors["login_intro"]}
      >
        <textarea
          id="login_intro"
          rows={3}
          value={loginIntro}
          onChange={(e) => setLoginIntro(e.target.value)}
          disabled={!canWrite}
          className={`${inputClass} resize-y`}
        />
      </Field>

      <fieldset className="space-y-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <legend className="px-1 text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Account lockout policy
        </legend>
        <Field
          id="login_lockout_threshold"
          label="Failed-login threshold"
          hint="Number of consecutive failed logins before the account is locked. 1–100. Default: 10."
          errors={fieldErrors["login_lockout_threshold"]}
        >
          <input
            id="login_lockout_threshold"
            type="number"
            min={1}
            max={100}
            step={1}
            value={lockoutThreshold}
            onChange={(e) => setLockoutThreshold(e.target.value)}
            disabled={!canWrite}
            className={inputClass}
          />
        </Field>
        <Field
          id="login_lockout_seconds"
          label="Lockout duration (seconds)"
          hint="How long the account stays locked once the threshold is crossed. 60–86400 (1 min – 24 h). Default: 900 (15 min)."
          errors={fieldErrors["login_lockout_seconds"]}
        >
          <input
            id="login_lockout_seconds"
            type="number"
            min={60}
            max={24 * 60 * 60}
            step={1}
            value={lockoutSeconds}
            onChange={(e) => setLockoutSeconds(e.target.value)}
            disabled={!canWrite}
            className={inputClass}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <legend className="px-1 text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Authentication
        </legend>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={allowPasswordReset}
            onChange={(e) => setAllowPasswordReset(e.target.checked)}
            disabled={!canWrite}
            className="mt-0.5 h-4 w-4 rounded border-[color:var(--color-border)]"
          />
          <span>
            <span className="font-medium">Allow self-service password reset</span>
            <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
              Shows the “Forgot password?” link on the login page and enables the reset-email flow.
              Local accounts only - SSO users reset through their identity provider. Requires SMTP
              to actually deliver the email.
            </span>
          </span>
        </label>
      </fieldset>

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
      {ok ? <p className="text-sm text-[color:var(--color-success)]">Settings saved.</p> : null}

      {canWrite ? (
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      ) : (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          You have read-only access. The settings.write permission is required to edit.
        </p>
      )}
    </form>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";

function Field({
  id,
  label,
  hint,
  errors,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{hint}</p> : null}
      {errors && errors.length > 0 ? (
        <p className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Boxed slot with the exact pixel dimensions of one of the real brand-mark
 * placements, plus `overflow:hidden` so the user sees what (if anything)
 * gets cropped. The dotted border isn't part of the actual render - it's a
 * preview affordance to show the bounds.
 */
function PreviewSlot({
  label,
  widthPx,
  heightPx,
  children,
}: {
  label: string;
  widthPx: number;
  heightPx: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="flex items-center justify-center overflow-hidden rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]"
        style={{ width: widthPx, height: heightPx }}
      >
        {children}
      </div>
      <p className="mt-1 text-[0.7rem] text-[color:var(--color-fg-subtle)]">{label}</p>
    </div>
  );
}
