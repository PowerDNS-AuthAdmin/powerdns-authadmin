/**
 * app/(app)/admin/authentication/page.tsx
 *
 * The unified authentication admin surface. Lists every configured way to
 * sign in (Local Auth as a synthetic row, every OIDC provider, plus SAML
 * and LDAP rows when those land in PR 2 + PR 3 of
 * `feat/auth-providers-ldap-saml-webauthn`).
 *
 * The "Default sign-in method" selector at the top picks which provider
 * `/login` auto-redirects to on a fresh visit. Replaces the retired per-
 * provider `force_default` checkbox — exactly one default across the whole
 * app, persisted in `settings.auth_default_provider` as a typed-prefix
 * string (`local` | `oidc:<slug>` | `saml:<slug>` | `ldap:<slug>`).
 *
 * The per-protocol edit pages stay where they are: `/admin/auth-providers/oidc/[id]`
 * for OIDC (and `/admin/auth-providers/ldap/[id]` + `/admin/auth-providers/saml/[id]`
 * once they exist). This page is the index that hands off to them.
 */

import type { Metadata } from "next";
import { env } from "@/lib/env";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listAllOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { listAllSamlProviders } from "@/lib/db/repositories/saml-providers";
import { listAllLdapProviders } from "@/lib/db/repositories/ldap-providers";
import { envOidcProviderSummary } from "@/lib/auth/providers/oidc";
import { getAppSettings } from "@/lib/settings/app-settings";
import { ensureFreshOidcDiscovery } from "@/lib/auth/providers/oidc-discovery-sampler";
import { logger } from "@/lib/logger";
import { AuthenticationTable, type AuthRow } from "./_components/authentication-table";
import { DefaultProviderSelector } from "./_components/default-provider-selector";

export const metadata: Metadata = { title: "Authentication" };

export default async function AuthenticationPage() {
  const { ability } = await requireUserForPage({ can: "auth.read" });
  const canManage = ability.can("manage", "Auth");

  // Opportunistic discovery refresh — same staleness-gated probe the old
  // OIDC list page ran. Best-effort; failures here don't stall the render.
  try {
    await ensureFreshOidcDiscovery();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "unknown" },
      "oidc.discovery.ensureFresh.failed",
    );
  }

  const [providers, samlProviders, ldapProviders, settings] = await Promise.all([
    listAllOidcProviders(),
    listAllSamlProviders(),
    listAllLdapProviders(),
    getAppSettings(),
  ]);
  const envProvider = envOidcProviderSummary();
  const envShadowed = envProvider !== null && providers.some((p) => p.slug === envProvider.slug);
  const showEnvRow = envProvider !== null && !envShadowed;

  // Assemble the unified row list. Local Auth is always present when
  // LOCAL_AUTH_ENABLED — it's not a configurable "provider" per se (its
  // settings live on /admin/settings: signup, captcha, lockout) but it
  // IS a way operators sign in, so it belongs in the same overview.
  const rows: AuthRow[] = [];
  if (env.LOCAL_AUTH_ENABLED) {
    rows.push({
      kind: "local",
      id: "local",
      slug: "local",
      name: "Local Auth",
      description:
        "Email + password sign-in. Configure signup, captcha, and lockout under Settings.",
      enabled: true,
      protocol: "Local",
      detailHref: "/admin/settings",
      canEdit: ability.can("read", "Settings"),
      iconUrl: null,
    });
  }
  for (const p of providers) {
    rows.push({
      kind: "oidc-db",
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.issuerUrl,
      enabled: p.enabled,
      protocol: "OIDC",
      detailHref: `/admin/auth-providers/oidc/${p.id}`,
      canEdit: canManage,
      iconUrl: p.iconUrl,
    });
  }
  for (const p of samlProviders) {
    rows.push({
      kind: "saml-db",
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.idpEntityId,
      enabled: p.enabled,
      protocol: "SAML",
      detailHref: `/admin/auth-providers/saml/${p.id}`,
      canEdit: canManage,
      iconUrl: null,
    });
  }
  for (const l of ldapProviders) {
    rows.push({
      kind: "ldap-db",
      id: l.id,
      slug: l.slug,
      name: l.name,
      // Show the server URL — bind DN lives on the detail page.
      description: l.serverUrl,
      enabled: l.enabled,
      protocol: "LDAP",
      detailHref: `/admin/auth-providers/ldap/${l.id}`,
      canEdit: canManage,
      iconUrl: null,
    });
  }
  if (showEnvRow && envProvider) {
    rows.push({
      kind: "oidc-env",
      id: `env:${envProvider.slug}`,
      slug: envProvider.slug,
      name: envProvider.name,
      description: `${envProvider.issuerUrl} (configured via OIDC_* env vars)`,
      enabled: true,
      protocol: "OIDC",
      detailHref: null,
      canEdit: false,
      iconUrl: null,
    });
  }

  // The default-provider dropdown's options. Local Auth is always present
  // (when LOCAL_AUTH_ENABLED — otherwise the operator can't pick it as a
  // default anyway). Each enabled provider adds one option.
  const defaultProviderOptions: Array<{
    value: string;
    label: string;
    description: string;
    protocol: string;
  }> = [];
  if (env.LOCAL_AUTH_ENABLED) {
    defaultProviderOptions.push({
      value: "local",
      label: "Local Auth",
      description: "Email + password — shows the form on /login.",
      protocol: "Local",
    });
  }
  for (const p of providers) {
    if (!p.enabled) continue;
    defaultProviderOptions.push({
      value: `oidc:${p.slug}`,
      label: p.name,
      description: p.issuerUrl,
      protocol: "OIDC",
    });
  }
  for (const p of samlProviders) {
    if (!p.enabled) continue;
    defaultProviderOptions.push({
      value: `saml:${p.slug}`,
      label: p.name,
      description: p.idpEntityId,
      protocol: "SAML",
    });
  }
  for (const l of ldapProviders) {
    if (!l.enabled) continue;
    defaultProviderOptions.push({
      value: `ldap:${l.slug}`,
      label: l.name,
      description: l.serverUrl,
      protocol: "LDAP",
    });
  }
  if (showEnvRow && envProvider) {
    defaultProviderOptions.push({
      value: `oidc:${envProvider.slug}`,
      label: `${envProvider.name} (env)`,
      description: envProvider.issuerUrl,
      protocol: "OIDC",
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Authentication</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Every configured way to sign in — local password, OIDC, LDAP, and (soon) SAML. The
            default below decides which one <code>/login</code> auto-redirects to on a fresh visit.
          </p>
        </div>
        {canManage ? <CreateButton href="/admin/authentication/new" label="Add provider" /> : null}
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <DefaultProviderSelector
          initial={settings.authDefaultProvider}
          options={defaultProviderOptions}
          canEdit={ability.can("write", "Settings")}
        />
      </section>

      {rows.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No sign-in methods configured yet. Add an OIDC provider above, or enable local auth via{" "}
          <code>LOCAL_AUTH_ENABLED=true</code>.
        </p>
      ) : (
        <AuthenticationTable rows={rows} />
      )}
    </div>
  );
}
