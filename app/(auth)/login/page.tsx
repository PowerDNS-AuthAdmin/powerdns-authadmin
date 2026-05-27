/**
 * app/(auth)/login/page.tsx
 *
 * Login page. Lists the configured auth methods and renders a form for
 * local sign-in plus a link for each enabled OIDC provider.
 *
 * The page is a server component — it reads `env` and decides which methods
 * are visible. The actual form submission is handled by a client component
 * (`LoginForm`) so we can give immediate feedback on errors.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { env, isProduction } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth/get-current-user";
import { listEnabledOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { envOidcProviderSummary } from "@/lib/auth/providers/oidc";
import { getAppSettings } from "@/lib/settings/app-settings";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { detectAppUrlMismatch } from "@/lib/auth/app-url-check";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    next?: string;
    "signed-out"?: string;
    flash?: string;
    "force-local"?: string;
  }>;
}) {
  // Already signed in? Send them to the dashboard.
  const current = await getCurrentUser();
  if (current) redirect("/dashboard");

  const {
    error,
    next,
    "signed-out": signedOut,
    flash,
    "force-local": forceLocal,
  } = await searchParams;
  const { loginIntro, allowPasswordReset } = await getAppSettings();

  // APP_URL misconfig — the browser silently rejects pda_session / pda_csrf
  // when the cookie host doesn't match the address bar, and sign-in just
  // looks "stuck" with no console message unless DevTools is open. Surface
  // it inline so operators see it before the first failed submit.
  const appUrlCheck = detectAppUrlMismatch(
    await headers(),
    env.APP_URL,
    isProduction ? "https" : "http",
  );

  // Validate the attempted-destination param once (open-redirect guard, L-2).
  // Carried through the local + OIDC flows; empty when it's just the default.
  const safeNext = safeNextPath(next);
  const nextParam = safeNext !== "/dashboard" ? `?next=${encodeURIComponent(safeNext)}` : "";

  // The env-configured provider (read-only, "Configured by ENV") is offered
  // alongside DB providers, not as a hidden fallback. A DB provider with the
  // same slug shadows it. See lib/auth/providers/oidc.ts for the matching
  // precedence on the dispatcher side.
  const dbProviders = await listEnabledOidcProviders();
  const dbSlugs = new Set(dbProviders.map((p) => p.slug));
  const envProvider = envOidcProviderSummary();
  const oidcProviders: Array<{ id: string; name: string; iconUrl: string | null }> = [
    ...dbProviders.map((p) => ({ id: p.slug, name: p.name, iconUrl: p.iconUrl })),
    // Env provider has no icon (env carries none) and is skipped when a DB
    // provider already claims its slug.
    ...(envProvider && !dbSlugs.has(envProvider.slug)
      ? [{ id: envProvider.slug, name: envProvider.name, iconUrl: null }]
      : []),
  ];

  // Default sign-in method: when `authDefaultProvider` resolves to a typed-
  // prefix value (e.g. `oidc:company-sso`), auto-redirect to that provider's
  // initiate URL instead of showing the form. Skipped on post-signout, post-
  // error, flash redirects, and when the operator opts out explicitly via
  // `?force-local=1` (the escape hatch for fixing a broken IdP or local-admin
  // recovery). The setting is global (one value across the app); per-provider
  // `force_default` is retired (migrated to this setting at upgrade time).
  const forceLocalRequested = forceLocal !== undefined;
  const isFreshArrival = !error && !signedOut && !flash && !forceLocalRequested;
  const { authDefaultProvider } = await getAppSettings();
  if (isFreshArrival && authDefaultProvider !== "local") {
    const sep = authDefaultProvider.indexOf(":");
    const type = sep > 0 ? authDefaultProvider.slice(0, sep) : "";
    const slug = sep > 0 ? authDefaultProvider.slice(sep + 1) : "";
    // For now only OIDC is supported — LDAP/SAML providers land in PR 2/3
    // and will plug into this same dispatch. A setting that resolves to an
    // unsupported type (or a provider whose row was deleted) silently falls
    // back to showing the form rather than redirecting to a 404.
    if (type === "oidc" && slug && dbProviders.some((p) => p.slug === slug && p.enabled)) {
      redirect(`/api/auth/oidc/${slug}/initiate${nextParam}`);
    }
  }

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Use your team credentials to continue.
        </p>
      </header>

      {appUrlCheck?.mismatch ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-3 text-sm"
        >
          <strong className="text-[color:var(--color-error)]">
            APP_URL mismatch — sign-in will fail.
          </strong>
          <p className="mt-1 text-[color:var(--color-fg)]">
            You opened this page at <code className="font-mono">{appUrlCheck.actualOrigin}</code>{" "}
            but the app is configured with{" "}
            <code className="font-mono">APP_URL={appUrlCheck.expectedOrigin}</code>. Session and
            CSRF cookies are scoped to{" "}
            <code className="font-mono">{appUrlCheck.expectedOrigin}</code>, so your browser will
            silently reject them.
          </p>
          <p className="mt-2 text-[color:var(--color-fg-muted)]">
            Fix: set <code className="font-mono">APP_URL</code> to the exact scheme + host + port
            you typed in the address bar and restart the app. See{" "}
            <a
              href="https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/blob/main/docs/02-INSTALLATION.md#2-set-app_url"
              className="underline"
              target="_blank"
              rel="noreferrer noopener"
            >
              Installation → Set APP_URL
            </a>
            .
          </p>
        </div>
      ) : null}

      {loginIntro ? (
        <div className="mb-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-sm whitespace-pre-line">
          {loginIntro}
        </div>
      ) : null}

      {signedOut ? (
        <div className="mb-4 rounded-md border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm">
          You&apos;ve been signed out.
        </div>
      ) : null}

      {flash ? <FlashBanner kind={flash} /> : null}

      {error ? (
        <div className="mb-4 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-3 text-sm text-[color:var(--color-error)]">
          {humanizeError(error)}
        </div>
      ) : null}

      {oidcProviders.length > 0 ? (
        <div className="mb-6 space-y-2">
          {oidcProviders.map((p) => (
            <a
              key={p.id}
              href={`/api/auth/oidc/${p.id}/initiate${nextParam}`}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-bg-muted)]"
            >
              {p.iconUrl ? (
                // Icon is operator-supplied; CSP `img-src` already
                // allows https + data: so the
                // browser will load it. Sized to match the button
                // text height so it doesn't dominate.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.iconUrl}
                  alt=""
                  style={{ width: 20, height: 20, objectFit: "contain", display: "block" }}
                />
              ) : null}
              <span>Continue with {p.name}</span>
            </a>
          ))}
          {env.LOCAL_AUTH_ENABLED ? (
            <div className="my-4 flex items-center gap-3 text-xs text-[color:var(--color-fg-subtle)]">
              <span className="h-px flex-1 bg-[color:var(--color-border)]" />
              <span>or</span>
              <span className="h-px flex-1 bg-[color:var(--color-border)]" />
            </div>
          ) : null}
        </div>
      ) : null}

      {env.LOCAL_AUTH_ENABLED ? (
        <>
          <LoginForm turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? undefined} next={safeNext} />
          {allowPasswordReset ? (
            <p className="mt-3 text-xs text-[color:var(--color-fg-muted)]">
              <Link href="/reset-password" className="underline">
                Forgot password?
              </Link>
            </p>
          ) : null}
          {/* Self-service signup link — only when SIGNUP_ENABLED. The page
              itself 404s when disabled, so this is the matching UI gate. */}
          {env.SIGNUP_ENABLED ? (
            <p className="mt-2 text-xs text-[color:var(--color-fg-muted)]">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="underline">
                Create an account
              </Link>
            </p>
          ) : null}
        </>
      ) : null}

      {forceLocalRequested ? (
        <p className="mt-4 text-xs text-[color:var(--color-fg-muted)]">
          Force-default OIDC bypassed for this visit. Remove <code>?force-local=1</code> from the
          URL to return to the normal login flow.
        </p>
      ) : null}
    </>
  );
}

/**
 * Render a one-off flash banner above the form. Vocabulary is
 * intentionally small — flash values emitted from elsewhere in the
 * app each get an entry here so a typoed redirect doesn't render
 * cryptic strings. Unknown codes render as a generic info banner
 * (so the user still gets feedback) but the dev gets a console
 * warning to add the case.
 */
function FlashBanner({ kind }: { kind: string }) {
  const message = flashMessage(kind);
  if (message === null) return null;
  const isSuccess = message.tone === "success";
  return (
    <div
      role="status"
      className={
        isSuccess
          ? "mb-4 rounded-md border border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 p-3 text-sm"
          : "mb-4 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 p-3 text-sm"
      }
    >
      {message.text}
    </div>
  );
}

interface FlashContent {
  text: string;
  tone: "success" | "info";
}

function flashMessage(kind: string): FlashContent | null {
  switch (kind) {
    case "email-changed":
      // Emitted by `/api/profile/email/change/confirm` after the
      // swap. Sessions were revoked server-side; the user
      // is here to sign back in with the NEW email.
      return {
        text: "Email address updated. Sign in with your new email to continue.",
        tone: "success",
      };
    case "session-required":
      // Emitted by `requireUserForPage` when an unauthenticated
      // request hits an authed page.
      return { text: "Please sign in to continue.", tone: "info" };
    default:
      return null;
  }
}

function humanizeError(code: string): string {
  switch (code) {
    case "oidc-unknown-provider":
      return "The OIDC provider in the request URL is not configured.";
    case "oidc-state-missing":
      return "Your sign-in attempt expired. Please try again.";
    case "oidc-exchange-failed":
      return "We couldn't complete the sign-in with your identity provider.";
    case "oidc-email-unverified":
      return "Sign-in refused: the identity provider did not attest that this email address is verified.";
    case "oidc-not-authorized":
      return "Sign-in refused: your account is not authorized for this system. Contact your administrator if you believe this is a mistake.";
    case "captcha-required":
      return "Sign-in requires a captcha challenge. Refresh the page and try again.";
    case "captcha-failed":
      return "Captcha verification failed. Please try again.";
    case "session-expired":
      return "Your session expired. Sign in again to continue.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
