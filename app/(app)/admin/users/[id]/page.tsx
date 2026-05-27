/**
 * app/(app)/admin/users/[id]/page.tsx
 *
 * Single-user admin view: account, edit-name + disable + force-reset
 * actions, and the role-assignment list (read + add + remove).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findUserById } from "@/lib/db/repositories/users";
import { listAssignmentsForUserWithRole, listRoles } from "@/lib/db/repositories/roles";
import { listAllTeams } from "@/lib/db/repositories/teams";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { listGrantsForUser } from "@/lib/db/repositories/zone-grants";
import { listSessionsForUser } from "@/lib/db/repositories/sessions";
import { listApiTokensForUser } from "@/lib/db/repositories/api-tokens";
import { recentAdminEditsForUser } from "@/lib/db/repositories/audit-log";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { UserActions } from "../_components/user-actions";
import { RoleAssignmentsPanel } from "../_components/role-assignments-panel";
import { ZoneGrantsPanel } from "../_components/zone-grants-panel";
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
  const target = await findUserById(id);
  if (!target) notFound();

  const canUpdate = ability.can("update", "User");
  const canReset = ability.can("reset-password", "User");
  const canDelete = ability.can("delete", "User");
  const canAssignRoles = ability.can("assign", "Role");
  const canReadAudit = ability.can("read", "Audit");
  const isSelf = id === actor.id;

  const [assignments, allRoles, allTeams, allServers, grants, sessions, tokens, recentEdits] =
    await Promise.all([
      listAssignmentsForUserWithRole(id),
      listRoles(),
      listAllTeams(),
      listAllPdnsServers(),
      listGrantsForUser(id),
      listSessionsForUser(id),
      listApiTokensForUser(id),
      canReadAudit
        ? recentAdminEditsForUser(id, 10)
        : Promise.resolve([] as Awaited<ReturnType<typeof recentAdminEditsForUser>>),
    ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{target.name ?? target.email}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">{target.email}</p>
      </header>

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
          <Row label="Last IP" value={target.lastLoginIp ?? "—"} />
          <Row label="Failed attempts" value={String(target.failedLoginCount)} />
        </dl>
      </section>

      <UserActions
        userId={id}
        initialName={target.name ?? ""}
        disabled={target.disabledAt !== null}
        mustChangePassword={target.mustChangePassword}
        ssoOnly={target.passwordHash === null}
        canUpdate={canUpdate}
        canReset={canReset}
        canDelete={canDelete && !isSelf}
        isSelf={isSelf}
      />

      <MfaPanel
        userId={id}
        canManage={canUpdate}
        totpEnabled={target.totpSecretEncrypted !== null}
        isSelf={isSelf}
      />

      {/* SSO-only users can't enroll TOTP in this app — the IdP is the
          second-factor authority. The override is hidden for them: forcing it
          would only deadlock the account. See lib/auth/mfa-compliance.ts for
          the matching policy on the enforcement side. */}
      {canUpdate && target.passwordHash !== null ? (
        <MfaRequiredOverride userId={id} initial={target.mfaRequired} />
      ) : null}

      <RoleAssignmentsPanel
        userId={id}
        canManage={canAssignRoles}
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

      <ZoneGrantsPanel
        userId={id}
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

      <SessionsPanel
        userId={id}
        canManage={canUpdate}
        isSelf={isSelf}
        sessions={sessions.map((s) => ({
          id: s.id,
          // Ship UTC ISO — client renders in the browser's local zone.
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
        }))}
      />

      <TokensPanel
        userId={id}
        canManage={canUpdate}
        isSelf={isSelf}
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

      {canReadAudit ? (
        <AdminAuditPanel
          entries={recentEdits}
          fullHistoryHref={`/admin/audit?resourceType=user&resourceId=${encodeURIComponent(id)}`}
        />
      ) : null}
    </div>
  );
}

// Subset of the master vocabulary that makes sense as a per-zone grant.
// We deliberately omit user/team/role/server administration: a per-zone
// grant scope can't meaningfully gate those resources, and showing
// them in the picker would confuse operators.
const ZONE_GRANT_PERMISSIONS: readonly string[] = PERMISSIONS.filter((p) =>
  /^(zone|record|dnssec|metadata|tsig)\./.test(p),
);

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
