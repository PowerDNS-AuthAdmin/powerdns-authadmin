/**
 * app/(app)/profile/page.tsx
 *
 * Personal-account view: who you're signed in as, change-password form,
 * and your active sessions. Permission: any authenticated user.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listSessionsForUser } from "@/lib/db/repositories/sessions";
import { listRoleSlugsForUser, loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { listApiTokensForUser } from "@/lib/db/repositories/api-tokens";
import { ApiTokensSection } from "./_components/api-tokens-section";
import { ChangeEmailForm } from "./_components/change-email-form";
import { ChangePasswordForm } from "./_components/change-password-form";
import { NameEdit } from "./_components/name-edit";
import { SessionsList } from "./_components/sessions-list";
import { TotpSection } from "./_components/totp-section";
import { PasskeysSection } from "./_components/passkeys-section";
import { SectionTabs, SectionTabPanel } from "@/components/ui/section-tabs";
import { ComplianceBanner } from "@/components/auth/compliance-guard";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ "mfa-required"?: string; because?: string }>;
}) {
  const { "mfa-required": mfaRequiredParam, because: mfaRequiredBecause } = await searchParams;
  const mfaRequired = mfaRequiredParam === "1";
  const requiringRoleSlugs = mfaRequiredBecause
    ? mfaRequiredBecause.split(",").filter(Boolean)
    : [];

  const { user } = await requireUserForPage();
  const [sessions, roleSlugs, tokens, assignments] = await Promise.all([
    listSessionsForUser(user.id),
    listRoleSlugsForUser(user.id),
    listApiTokensForUser(user.id),
    loadUserAssignmentsForAbility(user.id),
  ]);

  // Effective permission set for the token-issuance scope picker.
  // Computed server-side so the client component doesn't import the
  // server-only PERMISSIONS vocab. Sorted for stable display.
  const availablePermissions = Array.from(
    new Set(assignments.flatMap((a) => a.permissions)),
  ).sort();

  // Tabs. Conditional entries hide when their section is absent —
  // change-password / change-email are only meaningful when the user
  // has a local password (SSO-only accounts manage these upstream).
  const tabs = [
    { id: "account", label: "Account" },
    ...(user.passwordHash
      ? [
          { id: "change-password", label: "Password" },
          { id: "change-email", label: "Email" },
        ]
      : []),
    { id: "sessions", label: `Sessions (${sessions.length})` },
    { id: "mfa", label: "Two-factor" },
    { id: "api-tokens", label: `API tokens (${tokens.length})` },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Manage your account, password, and active sessions.
        </p>
      </header>

      <SectionTabs tabs={tabs} defaultTab="account">
        <ComplianceBanner />

        <SectionTabPanel id="account">
          <div className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
            <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              Account
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
              <Row label="Email" value={user.email} />
              <div className="contents">
                <dt className="text-[color:var(--color-fg-muted)]">Name</dt>
                <dd className="min-w-0">
                  <NameEdit initialName={user.name} />
                </dd>
              </div>
              <Row
                label="Last sign-in"
                value={
                  user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "First session"
                }
              />
              <div className="contents">
                <dt className="text-[color:var(--color-fg-muted)]">Roles</dt>
                <dd className="min-w-0">
                  <RoleChips slugs={roleSlugs} />
                </dd>
              </div>
              <Row
                label="Local password"
                value={user.passwordHash ? "Set" : "SSO-only (no local password)"}
              />
            </dl>
          </div>
        </SectionTabPanel>

        {user.passwordHash ? (
          <SectionTabPanel id="change-password">
            <div className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
              <header>
                <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                  Change password
                </h2>
                <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                  Minimum 12 characters. Existing sessions stay valid — revoke them below if you
                  want to sign out elsewhere.
                </p>
              </header>
              <ChangePasswordForm turnstileSiteKey={env.TURNSTILE_SITE_KEY} />
            </div>
          </SectionTabPanel>
        ) : null}

        {user.passwordHash ? (
          <SectionTabPanel id="change-email">
            <div className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
              <header>
                <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                  Change email
                </h2>
                <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                  We mint a confirmation link to the new address. Until transactional email lands,
                  your admin will share the link from the audit log. Confirming the link revokes all
                  your sessions.
                </p>
              </header>
              <ChangeEmailForm />
            </div>
          </SectionTabPanel>
        ) : null}

        <SectionTabPanel id="sessions">
          <div className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
            <header>
              <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                Active sessions ({sessions.length})
              </h2>
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                Each row is one browser cookie tied to your account. Revoking a session forces a
                re-login from that browser.
              </p>
            </header>
            <SessionsList
              sessions={sessions.map((s) => ({
                id: s.id,
                ip: s.ip,
                userAgent: s.userAgent,
                lastSeenAt: s.lastSeenAt.toISOString(),
                expiresAt: s.expiresAt.toISOString(),
                createdAt: s.createdAt.toISOString(),
              }))}
            />
          </div>
        </SectionTabPanel>

        <SectionTabPanel id="mfa">
          <div className="space-y-4">
            <TotpSection
              initialEnabled={user.totpSecretEncrypted !== null}
              mfaRequired={mfaRequired}
              requiringRoleSlugs={requiringRoleSlugs}
              ssoOnly={user.passwordHash === null}
            />
            {env.WEBAUTHN_ENABLED ? (
              <PasskeysSection
                ssoOnly={user.passwordHash === null}
                initial={user.webauthnCredentials.map((c) => ({
                  id: c.id,
                  nickname: c.nickname,
                  transports: c.transports ?? [],
                  createdAt: c.createdAt,
                  lastUsedAt: c.lastUsedAt,
                }))}
              />
            ) : null}
          </div>
        </SectionTabPanel>

        <SectionTabPanel id="api-tokens">
          <ApiTokensSection
            initialTokens={tokens.map((t) => ({
              id: t.id,
              name: t.name,
              prefix: t.prefix,
              scopes: t.scopes,
              expiresAt: t.expiresAt?.toISOString() ?? null,
              lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
              revokedAt: t.revokedAt?.toISOString() ?? null,
              createdAt: t.createdAt.toISOString(),
            }))}
            availablePermissions={availablePermissions}
          />
        </SectionTabPanel>
      </SectionTabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-[color:var(--color-fg-muted)]">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

/**
 * Render the user's role-slug list as small chips instead of a
 * comma-joined string. Visual upgrade only — chips wrap cleanly when
 * the user has many roles + reads as discrete bound items rather
 * than one freeform field. Not links: most users don't have
 * `role.read` (it's an admin permission), and rendering "looks
 * clickable but isn't" for the non-admin majority would confuse
 * more than it helps. Admins navigate via the admin sidebar.
 */
function RoleChips({ slugs }: { slugs: readonly string[] }) {
  if (slugs.length === 0) {
    return <span className="text-[color:var(--color-fg-muted)]">None</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {slugs.map((slug) => (
        <span
          key={slug}
          className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.6875rem]"
        >
          {slug}
        </span>
      ))}
    </span>
  );
}
