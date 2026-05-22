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
import { getCurrentUser } from "@/lib/auth/get-current-user";
import { checkMfaCompliance } from "@/lib/auth/mfa-compliance";
import { listRoleMfaStatesForUser } from "@/lib/db/repositories/roles";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { UserMenu } from "@/components/ui/user-menu";
import { BrandMark } from "@/components/ui/brandmark";
import { DialogProvider } from "@/components/ui/dialog";
import { FlashListener } from "@/components/ui/flash-listener";
import { NavLink } from "@/components/ui/nav-link";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { getAppSettings } from "@/lib/settings/app-settings";

/**
 * Paths an MFA-non-compliant user is still allowed to visit so they
 * can enroll. Anything else triggers a redirect to /profile?mfa-required=1.
 * Match by prefix to cover sub-routes and the API surface.
 */
const MFA_REQUIRED_ALLOWLIST: readonly string[] = [
  "/profile",
  "/api/profile/mfa",
  "/api/auth/logout",
];

export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const current = await getCurrentUser();
  if (!current) {
    redirect("/login");
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
  if (!compliance.compliant) {
    const allowed = MFA_REQUIRED_ALLOWLIST.some((p) => pathname.startsWith(p));
    if (!allowed) {
      const because = encodeURIComponent(compliance.requiringRoleSlugs.join(","));
      redirect(`/profile?mfa-required=1&because=${because}`);
    }
  }

  const appSettings = await getAppSettings();

  const canReadZones = current.ability.can("read", "Zone");
  const canReadServers = current.ability.can("read", "Server");
  const canReadUsers = current.ability.can("read", "User");
  const canReadRoles = current.ability.can("read", "Role");
  const canReadTeams = current.ability.can("read", "Team");
  const canReadAudit = current.ability.can("read", "Audit");
  const canReadSettings = current.ability.can("read", "Settings");
  const canReadOidc = current.ability.can("read", "Oidc");
  const canUseTemplates = current.ability.can("use", "Template");
  const hasAdminSection =
    canReadServers ||
    canReadUsers ||
    canReadRoles ||
    canReadTeams ||
    canReadAudit ||
    canReadSettings ||
    canReadOidc ||
    canUseTemplates;

  return (
    <DialogProvider>
      <RealtimeProvider>
        <FlashListener />
        <div className="grid min-h-dvh grid-cols-[16rem_1fr] grid-rows-[3.5rem_1fr]">
          <aside className="row-span-2 border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
            <div className="flex h-14 items-center overflow-hidden border-b border-[color:var(--color-border)] px-4">
              <Link
                href="/dashboard"
                aria-label={`${appSettings.siteName} home`}
                className="flex w-full items-center justify-center overflow-hidden"
              >
                <BrandMark
                  siteName={appSettings.siteName}
                  brandLogoUrl={appSettings.brandLogoUrl}
                  width={224}
                  maxHeight={40}
                  priority
                />
              </Link>
            </div>
            <nav className="space-y-1 p-3 text-sm">
              <NavLink href="/dashboard" label="Dashboard" />
              {canReadZones ? <NavLink href="/zones" label="Zones" /> : null}
              {hasAdminSection ? (
                <NavSection label="Admin">
                  {canReadUsers ? <NavLink href="/admin/users" label="Users" /> : null}
                  {canReadRoles ? <NavLink href="/admin/roles" label="Roles" /> : null}
                  {canReadTeams ? <NavLink href="/admin/teams" label="Teams" /> : null}
                  {canReadServers ? (
                    <NavLink href="/admin/servers" label="PowerDNS servers" />
                  ) : null}
                  {canReadServers ? (
                    <NavLink href="/admin/pdns-clusters" label="PowerDNS clusters" />
                  ) : null}
                  {canReadOidc ? (
                    <NavLink href="/admin/oidc-providers" label="OIDC providers" />
                  ) : null}
                  {canUseTemplates ? (
                    <NavLink href="/admin/zone-templates" label="Zone templates" />
                  ) : null}
                  {canReadSettings ? <NavLink href="/admin/settings" label="Settings" /> : null}
                  {canReadAudit ? <NavLink href="/admin/audit" label="Audit log" /> : null}
                  {canReadAudit ? (
                    <NavLink href="/admin/pdns-requests" label="PowerDNS requests" />
                  ) : null}
                </NavSection>
              ) : null}
            </nav>
          </aside>

          <header className="flex h-14 items-center justify-end gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4">
            <ThemeToggle />
            <UserMenu email={current.user.email} name={current.user.name} />
          </header>

          <section className="overflow-y-auto p-8">{children}</section>
        </div>
      </RealtimeProvider>
    </DialogProvider>
  );
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pt-4">
      <div className="px-3 pb-1 text-xs font-medium tracking-wide text-[color:var(--color-fg-subtle)] uppercase">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
