/**
 * app/(app)/admin/users/[id]/page.tsx
 *
 * Single-user admin view: account basics + tabbed panels for roles,
 * zone grants, sessions, two-factor, API tokens, and the audit feed.
 * Same tab vocabulary as `/profile` - operators get one consistent
 * shape regardless of which surface they manage from.
 *
 * Self-edit: when the actor opens their own row, server-side
 * `redirect()`s to `/profile`. The redirect happens at request time,
 * so the admin user-detail URL never appears in browser history -
 * clicking "Back" from /profile returns the operator to the admin
 * users list, not back into a redirect loop.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { isBootstrapAdminLocked } from "@/lib/auth/bootstrap-admin";
import { findUserById } from "@/lib/db/repositories/users";
import { listAssignmentsForUserWithRole, listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { listDirectGrantsForUser } from "@/lib/db/repositories/zone-grants";
import { listSessionsForUser } from "@/lib/db/repositories/sessions";
import { listApiTokensForUser } from "@/lib/db/repositories/api-tokens";
import { recentAdminEditsForUser } from "@/lib/db/repositories/audit-log";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { SectionTabs, SectionTabPanel } from "@/components/ui/section-tabs";
import { ZONE_GRANT_PERMISSIONS } from "@/lib/rbac/zone-grant-permissions";
import { UserActions } from "../_components/user-actions";
import { RoleAssignmentsPanel } from "../_components/role-assignments-panel";
import { ZoneGrantsPanel } from "../../_components/zone-grants-panel";
import { SessionsPanel } from "../_components/sessions-panel";
import { MfaPanel } from "../_components/mfa-panel";
import { MfaRequiredOverride } from "../_components/mfa-required-override";
import { TokensPanel } from "../_components/tokens-panel";
import { LocalTime } from "@/components/ui/local-time";

export const metadata: Metadata = { title: "User" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserDetailPage({ params }: PageProps) {
  const { user: actor, ability } = await requireUserForPage({ can: "user.read" });
  const { id } = await params;

  // Self-edit: bounce to /profile. The 307 from `redirect()` replaces
  // the in-flight nav, so `/admin/users/<self-id>` never lands in the
  // browser history - Back returns to the users-list page the operator
  // came from.
  if (id === actor.id) {
    redirect("/profile");
  }

  const target = await findUserById(id);
  if (!target) notFound();

  // The RO demo lock freezes this account's identity (login, roles, MFA
  // policy). Fold it into the capability flags so the management UI is
  // view-only for the bootstrap admin - the API routes enforce the same.
  const readonlyDemo = isBootstrapAdminLocked(target.email);
  const canUpdate = ability.can("update", "User") && !readonlyDemo;
  const canReset = ability.can("reset-password", "User") && !readonlyDemo;
  const canDelete = ability.can("delete", "User") && !readonlyDemo;
  const canAssignRoles = ability.can("assign", "Role");
  const canManageRoles = canAssignRoles && !readonlyDemo;
  const canReadAudit = ability.can("read", "Audit");

  const [assignments, allRoles, allTeams, allServers, grants, sessions, tokens, recentEdits] =
    await Promise.all([
      listAssignmentsForUserWithRole(id),
      listRoles(),
      listAllTeams(),
      listAllPdnsServers(),
      listDirectGrantsForUser(id),
      listSessionsForUser(id),
      listApiTokensForUser(id),
      canReadAudit
        ? recentAdminEditsForUser(id, 10)
        : Promise.resolve([] as Awaited<ReturnType<typeof recentAdminEditsForUser>>),
    ]);

  // Build the tab list. We surface a tab only when the actor has the
  // permission relevant to that panel - a read-only operator browsing
  // user-detail still sees Account, but won't see (e.g.) Roles unless
  // they hold `role.assign`.
  const tabs: Array<{ id: string; label: string }> = [{ id: "account", label: "Account" }];
  if (canAssignRoles) tabs.push({ id: "roles", label: "Roles" });
  if (canUpdate) tabs.push({ id: "zone-grants", label: "Zone grants" });
  tabs.push({ id: "sessions", label: `Sessions (${sessions.length})` });
  if (canUpdate) tabs.push({ id: "mfa", label: "Two-factor" });
  tabs.push({ id: "api-tokens", label: `API tokens (${tokens.length})` });
  if (canReadAudit) tabs.push({ id: "audit", label: "Audit" });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{target.name ?? target.email}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">{target.email}</p>
      </header>

      {/* Top-level actions stay outside the tab system - they act on the
          user identity itself, not on a specific tab's content. */}
      <UserActions
        userId={id}
        initialName={target.name ?? ""}
        disabled={target.disabledAt !== null}
        mustChangePassword={target.mustChangePassword}
        ssoOnly={target.passwordHash === null}
        canUpdate={canUpdate}
        canReset={canReset}
        canDelete={canDelete}
        isSelf={false}
        readonlyDemo={readonlyDemo}
      />

      <SectionTabs tabs={tabs} defaultTab="account">
        <SectionTabPanel id="account">
          <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
            <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              Account
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
              <Row label="Status" value={target.disabledAt ? "Disabled" : "Active"} />
              <Row label="Local password" value={target.passwordHash ? "Set" : "SSO-only"} />
              <Row label="Must change password" value={target.mustChangePassword ? "Yes" : "No"} />
              <Row label="Email verified" value={target.emailVerifiedAt ? "Yes" : "No"} />
              <Row
                label="Last sign-in"
                value={target.lastLoginAt ? <LocalTime ts={target.lastLoginAt} /> : "Never"}
              />
              <Row label="Last IP" value={target.lastLoginIp ?? "-"} />
              <Row label="Failed attempts" value={String(target.failedLoginCount)} />
            </dl>
          </section>
        </SectionTabPanel>

        {canAssignRoles ? (
          <SectionTabPanel id="roles">
            <RoleAssignmentsPanel
              userId={id}
              canManage={canManageRoles}
              assignments={assignments.map((a) => ({
                assignmentId: a.assignmentId,
                roleSlug: a.roleSlug,
                roleName: a.roleName,
                isSystem: a.isSystem,
                scopeType: a.scopeType,
                scopeId: a.scopeId,
                scopeLabel: labelForScope(a.scopeType, a.scopeId, allTeams, allServers),
                createdAt: a.createdAt.toISOString(),
              }))}
              roles={allRoles.map((r) => ({
                id: r.id,
                slug: r.slug,
                name: r.name,
                isSystem: r.isSystem,
              }))}
              teams={allTeams.map((t) => ({ id: t.id, name: t.name }))}
              servers={allServers.map((s) => ({ id: s.id, name: s.name }))}
            />
          </SectionTabPanel>
        ) : null}

        {canUpdate ? (
          <SectionTabPanel id="zone-grants">
            <ZoneGrantsPanel
              endpointBase={`/api/admin/users/${id}/zone-grants`}
              principalKind="user"
              canManage={canUpdate}
              grants={grants.map((g) => {
                const server = allServers.find((s) => s.id === g.serverId);
                return {
                  id: g.id,
                  serverId: g.serverId,
                  serverName: server?.name ?? "(unknown server)",
                  zoneName: g.zoneName,
                  permissions: g.permissions,
                };
              })}
              servers={allServers.map((s) => ({ id: s.id, name: s.name }))}
              permissionVocab={ZONE_GRANT_PERMISSIONS}
            />
          </SectionTabPanel>
        ) : null}

        <SectionTabPanel id="sessions">
          <SessionsPanel
            userId={id}
            canManage={canUpdate}
            isSelf={false}
            sessions={sessions.map((s) => ({
              id: s.id,
              lastSeenAt: s.lastSeenAt.toISOString(),
              expiresAt: s.expiresAt.toISOString(),
              ip: s.ip,
              userAgent: s.userAgent,
            }))}
          />
        </SectionTabPanel>

        {canUpdate ? (
          <SectionTabPanel id="mfa">
            <MfaPanel
              userId={id}
              canManage={canUpdate}
              totpEnabled={target.totpSecretEncrypted !== null}
              isSelf={false}
            />
            {/* SSO-only users can't enroll TOTP in this app - the IdP is the
                second-factor authority. Hidden for them: forcing the override
                would only deadlock the account. See lib/auth/mfa-compliance.ts. */}
            {target.passwordHash !== null && !readonlyDemo ? (
              <div className="mt-4">
                <MfaRequiredOverride userId={id} initial={target.mfaRequired} />
              </div>
            ) : null}
          </SectionTabPanel>
        ) : null}

        <SectionTabPanel id="api-tokens">
          <TokensPanel
            userId={id}
            canManage={canUpdate}
            isSelf={false}
            tokens={tokens.map((t) => ({
              id: t.id,
              name: t.name,
              prefix: t.prefix,
              scopes: t.scopes,
              createdAt: t.createdAt.toISOString(),
              lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
              expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
              revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
            }))}
          />
        </SectionTabPanel>

        {canReadAudit ? (
          <SectionTabPanel id="audit">
            <AdminAuditPanel
              entries={recentEdits}
              fullHistoryHref={`/admin/audit?resourceType=user&resourceId=${encodeURIComponent(id)}`}
            />
          </SectionTabPanel>
        ) : null}
      </SectionTabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-[color:var(--color-fg-muted)]">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

function labelForScope(
  scopeType: "global" | "team" | "zone" | "server",
  scopeId: string | null,
  teams: Array<{ id: string; name: string }>,
  servers: Array<{ id: string; name: string }>,
): string {
  if (scopeType === "global") return "global";
  if (scopeId === null) return scopeType;
  if (scopeType === "team") {
    return `team: ${teams.find((t) => t.id === scopeId)?.name ?? scopeId}`;
  }
  if (scopeType === "server") {
    return `server: ${servers.find((s) => s.id === scopeId)?.name ?? scopeId}`;
  }
  return `zone: ${scopeId}`;
}
