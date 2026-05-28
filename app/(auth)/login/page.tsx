/**
 * app/(auth)/login/page.tsx
 *
 * Login page. Renders the local form when LOCAL_AUTH_ENABLED, then a
 * unified "or sign in with" list of non-local sign-in methods: passkey,
 * every enabled OIDC provider, every enabled SAML provider, every enabled
 * LDAP provider. Each option is a single button labelled with the
 * provider name — no "Continue with" / "Sign in with" prefixes.
 *
 * Clicking an LDAP button focuses that provider's username/password
 * form via `?ldap=<slug>`, since LDAP needs an on-page credential prompt
 * (the bind happens server-side; the user types directly into our form).
 * OIDC + SAML redirect straight to the IdP. Passkey runs an in-page
 * WebAuthn discoverable-credential flow.
 *
 * The page is a server component — it reads `env` and the enabled-provider
 * tables and decides which methods to render. The form submission, LDAP
 * form, and passkey flow are client components.
 */

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { env, isProduction } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth/get-current-user";
import { listEnabledOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { listEnabledSamlProviders } from "@/lib/db/repositories/saml-providers";
import { listEnabledLdapProviders } from "@/lib/db/repositories/ldap-providers";
import { envOidcProviderSummary } from "@/lib/auth/providers/oidc";
import { getAppSettings } from "@/lib/settings/app-settings";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { detectAppUrlMismatch } from "@/lib/auth/app-url-check";
import { LoginForm } from "./login-form";
import { LdapLoginForm } from "./ldap-login-form";
import { PasskeyButton } from "./passkey-button";

export const metadata: Metadata = { title: "Sign in" };

interface ProviderButton {
  key: string;
  label: string;
  href: string;
  iconUrl?: string | null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    next?: string;
    "signed-out"?: string;
    flash?: string;
    "force-local"?: string;
    /** Focus a single LDAP provider's form (skips the unified provider list). */
    ldap?: string;
  }>;
}) {
  const current = await getCurrentUser();
  if (current) redirect("/dashboard");

  const {
    error,
    next,
    "signed-out": signedOut,
    flash,
    "force-local": forceLocal,
    ldap: ldapFocusSlug,
  } = await searchParams;
  const { loginIntro, allowPasswordReset } = await getAppSettings();

  const appUrlCheck = detectAppUrlMismatch(
    await headers(),
    env.APP_URL,
    isProduction ? "https" : "http",
  );

  const safeNext = safeNextPath(next);
  const nextParam = safeNext !== "/dashboard" ? `?next=${encodeURIComponent(safeNext)}` : "";

  const [dbProviders, dbLdapProviders, dbSamlProviders] = await Promise.all([
    listEnabledOidcProviders(),
    listEnabledLdapProviders(),
    listEnabledSamlProviders(),
  ]);
  const envProvider = envOidcProviderSummary();
  const dbSlugs = new Set(dbProviders.map((p) => p.slug));
  const oidcProviders: Array<{ id: string; name: string; iconUrl: string | null }> = [
    ...dbProviders.map((p) => ({ id: p.slug, name: p.name, iconUrl: p.iconUrl })),
    ...(envProvider && !dbSlugs.has(envProvider.slug)
      ? [{ id: envProvider.slug, name: envProvider.name, iconUrl: null }]
      : []),
  ];

  // Default sign-in method — auto-redirect a fresh visit to the pinned
  // provider's initiate URL. Skipped on post-signout, post-error, flash,
  // explicit `?force-local=1`, and within 60s of an explicit logout
  // (`pda_just_logged_out` cookie).
  const forceLocalRequested = forceLocal !== undefined;
  const justLoggedOut = (await cookies()).get("pda_just_logged_out")?.value === "1";
  const isFreshArrival =
    !error && !signedOut && !flash && !forceLocalRequested && !justLoggedOut;
  const { authDefaultProvider } = await getAppSettings();
  if (isFreshArrival && authDefaultProvider !== "local") {
    const sep = authDefaultProvider.indexOf(":");
    const type = sep > 0 ? authDefaultProvider.slice(0, sep) : "";
    const slug = sep > 0 ? authDefaultProvider.slice(sep + 1) : "";
    if (type === "oidc" && slug && dbProviders.some((p) => p.slug === slug && p.enabled)) {
      redirect(`/api/auth/oidc/${slug}/initiate${nextParam}`);
    }
    if (type === "saml" && slug && dbSamlProviders.some((p) => p.slug === slug && p.enabled)) {
      redirect(`/api/auth/saml/${slug}/login${nextParam}`);
    }
    if (type === "ldap" && slug && dbLdapProviders.some((p) => p.slug === slug && p.enabled)) {
      const sep2 = nextParam ? "&" : "?";
      redirect(`/login${nextParam}${sep2}ldap=${encodeURIComponent(slug)}`);
    }
  }

  // Build the unified non-local provider list. Each button is one option,
  // labelled with the provider's name only — no "Continue with" prefixes.
  const providerButtons: ProviderButton[] = [
    ...oidcProviders.map((p) => ({
      key: `oidc-${p.id}`,
      label: p.name,
      href: `/api/auth/oidc/${p.id}/initiate${nextParam}`,
      iconUrl: p.iconUrl,
    })),
    ...dbSamlProviders.map((p) => ({
      key: `saml-${p.slug}`,
      label: p.name,
      href: `/api/auth/saml/${p.slug}/login${nextParam}`,
    })),
    ...dbLdapProviders.map((p) => ({
      key: `ldap-${p.slug}`,
      label: p.name,
      // LDAP needs an in-page credential prompt — clicking the button
      // focuses that provider's form below.
      href: `/login${nextParam}${nextParam ? "&" : "?"}ldap=${encodeURIComponent(p.slug)}`,
    })),
  ];

  // Focus mode: when ?ldap=<slug> is set, render only that LDAP form.
  const focusedLdap =
    ldapFocusSlug !== undefined
      ? dbLdapProviders.find((l) => l.slug === ldapFocusSlug)
      : undefined;

  const showLocalForm = env.LOCAL_AUTH_ENABLED && focusedLdap === undefined;
  const showProviderList =
    focusedLdap === undefined && (providerButtons.length > 0 || env.WEBAUTHN_ENABLED);

  return (
    <>
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

      {showLocalForm ? (
        <div className="space-y-2">
          <LoginForm
            turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? undefined}
            next={safeNext}
          />
          {allowPasswordReset ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              <Link href="/reset-password" className="underline">
                Forgot password?
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {focusedLdap ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{focusedLdap.name}</h2>
          <LdapLoginForm
            slug={focusedLdap.slug}
            providerName={focusedLdap.name}
            turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? undefined}
            next={safeNext}
          />
        </section>
      ) : null}

      {showProviderList ? (
        <div className="mt-6 space-y-3">
          <div className="flex items-center gap-3 text-xs text-[color:var(--color-fg-subtle)]">
            <span className="h-px flex-1 bg-[color:var(--color-border)]" />
            <span>or sign in with</span>
            <span className="h-px flex-1 bg-[color:var(--color-border)]" />
          </div>

          <div className="space-y-2">
            {env.WEBAUTHN_ENABLED ? <PasskeyButton next={safeNext} /> : null}
            {providerButtons.map((p) => (
              <a
                key={p.key}
                href={p.href}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-bg-muted)]"
              >
                {p.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.iconUrl}
                    alt=""
                    style={{ width: 20, height: 20, objectFit: "contain", display: "block" }}
                  />
                ) : null}
                <span>{p.label}</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {showLocalForm && env.SIGNUP_ENABLED ? (
        <p className="mt-4 text-xs text-[color:var(--color-fg-muted)]">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="underline">
            Create an account
          </Link>
        </p>
      ) : null}

      {focusedLdap ? (
        <p className="mt-4 text-xs text-[color:var(--color-fg-muted)]">
          <Link
            href={env.LOCAL_AUTH_ENABLED ? "/login?force-local=1" : "/login"}
            className="underline"
          >
            Show all sign-in options
          </Link>
        </p>
      ) : null}
    </>
  );
}

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
      return {
        text: "Email address updated. Sign in with your new email to continue.",
        tone: "success",
      };
    case "session-required":
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
    case "saml-unknown-provider":
      return "The SAML provider in the request URL is not configured.";
    case "saml-state-missing":
      return "Your sign-in attempt expired. Please try again.";
    case "saml-response-missing":
      return "The SAML response was missing or malformed.";
    case "saml-exchange-failed":
      return "We couldn't verify the SAML assertion from your identity provider.";
    case "saml-build-failed":
      return "We couldn't build the SAML sign-in request.";
    case "saml-not-authorized":
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
