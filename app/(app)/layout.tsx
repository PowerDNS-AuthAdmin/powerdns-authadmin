/**
 * app/(app)/layout.tsx
 *
 * Chrome for every authenticated route: left sidebar with the wordmark + nav,
 * top bar with the theme toggle and the user menu on the right. Runs
 * `requireUser()` at the top — when there's no session, it redirects to
 * /login rather than throwing 401 (better UX than a JSON error for a browser).
 *
 * Per-page authorization (e.g. "only Admins can see /admin") happens in the
 * page server components, not here.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BookText } from "lucide-react";
import { APP_DOCS_URL, APP_SOURCE_TITLE, APP_SOURCE_URL, APP_VERSION_LABEL } from "@/lib/app-meta";
import { getCurrentUser } from "@/lib/auth/get-current-user";
import { checkMfaCompliance } from "@/lib/auth/mfa-compliance";
import { listRoleMfaStatesForUser } from "@/lib/db/repositories/roles";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { UserMenu } from "@/components/ui/user-menu";
import { HealthBell } from "@/components/domain/health-bell";
import { listActiveAdvisories } from "@/lib/db/repositories/backend-advisories";
import { BrandMark } from "@/components/ui/brandmark";
import { AppShell } from "@/components/ui/app-shell";
import { DialogProvider } from "@/components/ui/dialog";
import { FlashListener } from "@/components/ui/flash-listener";
import { NavLink } from "@/components/ui/nav-link";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { HeaderStatusProvider } from "@/components/realtime/header-status-chip";
import { ComplianceGuardProvider } from "@/components/auth/compliance-guard";
import { getAppSettings } from "@/lib/settings/app-settings";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { globalAnyLagging, hasReplicationTopology } from "@/lib/pdns/sync";
import { decideHeaderChipMode } from "@/lib/realtime/header-chip-mode";
import { pdnsBackgroundPollingEnabled } from "@/lib/env";

/**
 * Paths a non-compliant user (forced-MFA-not-enrolled, or flagged
 * `mustChangePassword`) is still allowed to visit so they can self-remediate.
 * Anything else triggers a redirect to /profile. Match by prefix to cover
 * sub-routes and the self-service API surface (enroll TOTP / change password /
 * log out).
 */
const COMPLIANCE_ALLOWLIST: readonly string[] = [
  "/profile",
  "/api/profile/mfa",
  "/api/auth/change-password",
  "/api/auth/logout",
];

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const current = await getCurrentUser();
  if (!current) {
    // Remember where they were headed so login can shunt them straight there
    // (L-2). The middleware forwards the pathname via `x-pathname`.
    const attempted = (await headers()).get("x-pathname");
    const next = attempted && attempted !== "/" ? `?next=${encodeURIComponent(attempted)}` : "";
    redirect(`/login${next}`);
  }

  // Required-MFA-per-role enforcement. When any of the
  // user's assigned roles is marked `requiresMfa` and the user
  // hasn't enrolled TOTP yet, shunt them to /profile so they can
  // enroll. The allowlist keeps /profile + the MFA-related API
  // surface reachable — without it the operator would be in a
  // deadlock.
  //
  // SSO-only users (no local password hash) are exempt: their IdP
  // is the second-factor authority. Adding a second TOTP gate on
  // top would be a TOTP-after-TOTP user-experience papercut without
  // increasing security — the IdP is already the trust root for
  // this account.
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "/";
  const allowed = COMPLIANCE_ALLOWLIST.some((p) => pathname.startsWith(p));

  const userRoles = await listRoleMfaStatesForUser(current.user.id);
  const compliance = checkMfaCompliance(
    {
      totpEnrolled: current.user.totpSecretEncrypted !== null,
      ssoOnly: current.user.passwordHash === null,
      // Per-user override (admin user-detail page) supersedes roles + SSO.
      mfaOverride: current.user.mfaRequired,
    },
    userRoles,
  );
  if (!compliance.compliant && !allowed) {
    const because = encodeURIComponent(compliance.requiringRoleSlugs.join(","));
    redirect(`/profile?mfa-required=1&because=${because}`);
  }

  // A temp/expired password must be rotated before the operator can use the
  // app. Mirrors the route-handler gate in `requireUser` (which throws);
  // the page path redirects to /profile for a friendlier prompt.
  if (current.user.mustChangePassword && !allowed) {
    redirect(`/profile?must-change-password=1`);
  }

  const appSettings = await getAppSettings();

  const canReadZones = current.ability.can("read", "Zone");
  const canReadServers = current.ability.can("read", "Server");
  const canReadTsig = current.ability.can("read", "Tsig");
  const canManageAutoprimary = current.ability.can("manage", "Autoprimary");
  const canReadUsers = current.ability.can("read", "User");
  const canReadRoles = current.ability.can("read", "Role");
  const canReadTeams = current.ability.can("read", "Team");
  const canReadAudit = current.ability.can("read", "Audit");
  const canReadSettings = current.ability.can("read", "Settings");
  const canReadOidc = current.ability.can("read", "Oidc");
  const canUseTemplates = current.ability.can("use", "Template");

  // Health-bell advisories (ADR-0015) — only for users who can read backends.
  const advisories = canReadServers
    ? (await listActiveAdvisories()).map((a) => ({
        id: a.id,
        backendId: a.backendId,
        backendName: a.backendName,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        acknowledged: a.acknowledgedAt !== null,
      }))
    : [];

  // Sidebar is grouped by function (Infrastructure / Access / System) rather
  // than one flat "Admin" pile. Each group renders only when the user can see
  // at least one of its children.
  const hasInfrastructure =
    canReadServers || canReadTsig || canManageAutoprimary || canUseTemplates;
  const hasAccess = canReadUsers || canReadRoles || canReadTeams || canReadOidc;
  const hasSystem = canReadSettings || canReadAudit;

  const sidebar = (
    <>
      <div className="flex h-20 shrink-0 items-center overflow-hidden border-b border-[color:var(--color-border)] px-4 pt-3">
        <Link
          href="/dashboard"
          aria-label={`${appSettings.siteName} home`}
          className="flex w-full items-center justify-center overflow-hidden"
        >
          <BrandMark
            siteName={appSettings.siteName}
            brandLogoUrl={appSettings.brandLogoUrl}
            width={280}
            maxHeight={56}
          />
        </Link>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3 text-base">
        <NavLink href="/dashboard" label="Dashboard" />
        {canReadZones ? <NavLink href="/zones" label="Zones" /> : null}

        {hasInfrastructure ? (
          <NavSection label="Infrastructure">
            {canReadServers ? (
              <NavLink nested href="/admin/servers" label="PowerDNS servers" />
            ) : null}
            {canReadServers ? <NavLink nested href="/admin/pdns-clusters" label="Groups" /> : null}
            {canReadTsig ? <NavLink nested href="/admin/tsig-keys" label="TSIG keys" /> : null}
            {canManageAutoprimary ? (
              <NavLink nested href="/admin/autoprimaries" label="Autoprimaries" />
            ) : null}
            {canUseTemplates ? (
              <NavLink nested href="/admin/zone-templates" label="Zone templates" />
            ) : null}
          </NavSection>
        ) : null}

        {hasAccess ? (
          <NavSection label="Access">
            {canReadUsers ? <NavLink nested href="/admin/users" label="Users" /> : null}
            {canReadTeams ? <NavLink nested href="/admin/teams" label="Teams" /> : null}
            {canReadRoles ? <NavLink nested href="/admin/roles" label="Roles" /> : null}
            {canReadOidc ? (
              <NavLink nested href="/admin/authentication" label="Authentication" />
            ) : null}
          </NavSection>
        ) : null}

        {hasSystem ? (
          <NavSection label="System">
            {canReadSettings ? <NavLink nested href="/admin/settings" label="Settings" /> : null}
            {canReadAudit ? <NavLink nested href="/admin/audit" label="Audit log" /> : null}
            {canReadAudit ? (
              <NavLink nested href="/admin/pdns-requests" label="Request log" />
            ) : null}
          </NavSection>
        ) : null}
      </nav>
      <SidebarFooter />
    </>
  );

  const headerControls = (
    <>
      {canReadServers ? <HealthBell advisories={advisories} /> : null}
      <ThemeToggle />
      <UserMenu email={current.user.email} name={current.user.name} />
    </>
  );

  // A user stuck on the must-change-password / MFA-enrolment screen can't reach
  // /api/realtime (requireUser rejects them with 403). Skipping RealtimeProvider
  // here avoids the stuck-on-CONNECTING chip + the wasted reconnect storm; the
  // chip self-hides when no provider is mounted.
  const realtimeAvailable = compliance.compliant && !current.user.mustChangePassword;

  // Fleet-wide sync verdict as the chip's default mode. Pages that show
  // their own (per-zone or per-page) sync state push it via
  // <HeaderStatusMode/> and override this. Computed only when realtime is
  // available + the operator can see backend state at all — otherwise the
  // chip falls back to plain "Live" so a profile-only user doesn't see a
  // signal they have no context for. The helper reads exclusively from the
  // poller's in-process caches, so this is a near-free lookup once the
  // first ensureBackendsObserved warms the store.
  // Sync-mode chip default. Pages that show their own per-zone or per-page
  // sync state override this via <HeaderStatusMode/>. The decision is a pure
  // function (`decideHeaderChipMode`) — unit-tested in isolation; the awaits
  // here are I/O bridges feeding it.
  const canReadBackends = canReadZones || canReadServers;
  const showGlobalSync = pdnsBackgroundPollingEnabled && realtimeAvailable && canReadBackends;
  let topology = false;
  let lagging = false;
  if (showGlobalSync) {
    await ensureBackendsObserved();
    topology = await hasReplicationTopology();
    if (topology) lagging = await globalAnyLagging();
  }
  const initialChipMode = decideHeaderChipMode({
    pollingEnabled: pdnsBackgroundPollingEnabled,
    realtimeAvailable,
    canReadBackends,
    hasReplicationTopology: topology,
    anyLagging: lagging,
  });

  const shell = (
    <AppShell sidebar={sidebar} headerControls={headerControls}>
      {children}
    </AppShell>
  );

  return (
    <DialogProvider>
      <ComplianceGuardProvider
        mfaRequired={!compliance.compliant}
        passwordChangeRequired={current.user.mustChangePassword}
      >
        {realtimeAvailable ? (
          <RealtimeProvider>
            <HeaderStatusProvider initialMode={initialChipMode}>
              <FlashListener />
              {shell}
            </HeaderStatusProvider>
          </RealtimeProvider>
        ) : (
          <>
            <FlashListener />
            {shell}
          </>
        )}
      </ComplianceGuardProvider>
    </DialogProvider>
  );
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pt-5">
      <div className="px-3 pb-1 text-[0.7rem] font-semibold tracking-wider text-[color:var(--color-fg)] uppercase">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * Pinned to the bottom of the sidebar (the aside is a flex column with a
 * scrollable nav above). Shows the running version linked to the source
 * repo, plus a docs shortcut. Version comes from package.json via
 * `lib/app-meta` so a release bump is a one-file change.
 */
function SidebarFooter() {
  return (
    <div className="shrink-0 border-t border-[color:var(--color-border)] px-4 py-3">
      <div className="flex items-center justify-between text-xs text-[color:var(--color-fg-muted)]">
        <a
          href={APP_SOURCE_URL}
          target="_blank"
          rel="noreferrer noopener"
          title={APP_SOURCE_TITLE}
          className="inline-flex items-center gap-1.5 hover:text-[color:var(--color-fg)]"
        >
          <GitHubMark className="h-3.5 w-3.5" />
          <span className="tabular-nums">v{APP_VERSION_LABEL}</span>
        </a>
        <a
          href={APP_DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          title="Documentation"
          className="inline-flex items-center gap-1.5 hover:text-[color:var(--color-fg)]"
        >
          <BookText aria-hidden className="h-3.5 w-3.5" />
          Docs
        </a>
      </div>
    </div>
  );
}

/**
 * GitHub mark — inlined because lucide-react dropped its brand icons over
 * licensing. Octicon path, scaled by the `className` height/width.
 */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
