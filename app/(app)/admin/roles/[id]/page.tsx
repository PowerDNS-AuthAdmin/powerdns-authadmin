/**
 * app/(app)/admin/roles/[id]/page.tsx
 *
 * Role detail. System roles render read-only (the seed file owns their
 * definition); custom roles render in the editable form gated on
 * `role.update`. Delete button appears for custom roles when the user
 * has `role.delete`. The narrow `requires_mfa` toggle remains available
 * for both kinds when the user has `role.update`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { countAssignmentsForRole, findRoleById } from "@/lib/db/repositories/roles";
import { recentAdminEditsForRole } from "@/lib/db/repositories/audit-log";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { RoleForm } from "../_components/role-form";
import { RequireMfaToggle } from "./_components/require-mfa-toggle";
import { DeleteRoleButton } from "./_components/delete-role-button";

export const metadata: Metadata = { title: "Role" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RoleDetailPage({ params }: PageProps) {
  const current = await requireUserForPage({ can: "role.read" });
  const { id } = await params;
  const role = await findRoleById(id);
  if (!role) notFound();

  const canEdit = current.ability.can("update", "Role");
  const canDelete = current.ability.can("delete", "Role");
  const canReadAudit = current.ability.can("read", "Audit");
  const recentEdits = canReadAudit ? await recentAdminEditsForRole(id, 10) : [];

  // For the delete-button copy + the system-role no-op rendering.
  const isCustom = !role.isSystem;
  const assignmentCount = isCustom && canDelete ? await countAssignmentsForRole(id) : 0;
  const grouped = groupByResource(role.permissions);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/admin/roles"
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          ← Back to roles
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{role.name}</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          <code className="font-mono">{role.slug}</code>
          {role.isSystem ? (
            <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.65rem] tracking-wide uppercase">
              system
            </span>
          ) : (
            <span className="ml-2 rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 text-[0.65rem] tracking-wide text-[color:var(--color-accent)] uppercase">
              custom
            </span>
          )}
        </p>
        {role.description && role.isSystem ? (
          <p className="mt-3 text-sm">{role.description}</p>
        ) : null}
      </header>

      {isCustom && canEdit ? (
        // Custom role + edit permission → render the full editable form.
        // Slug is fixed (immutable contract for OIDC group mappings).
        <section className="space-y-3">
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Edit role
          </h2>
          <RoleForm
            mode="edit"
            roleId={role.id}
            initialSlug={role.slug}
            initialName={role.name}
            initialDescription={role.description ?? ""}
            initialRequiresMfa={role.requiresMfa}
            initialPermissions={role.permissions}
            allPermissions={PERMISSIONS}
          />
        </section>
      ) : (
        // System role (always) OR custom role without edit permission →
        // read-only rendering plus the narrow MFA toggle when allowed.
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              MFA policy
            </h2>
            {canEdit ? (
              <RequireMfaToggle roleId={role.id} initialValue={role.requiresMfa} />
            ) : (
              <p className="text-sm text-[color:var(--color-fg-muted)]">
                {role.requiresMfa
                  ? "Users with this role must have TOTP enrolled."
                  : "MFA is not required for this role."}
              </p>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              Permissions ({role.permissions.length})
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(grouped).map(([resource, actions]) => (
                <div
                  key={resource}
                  className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4"
                >
                  <h3 className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                    {resource}
                  </h3>
                  <ul className="mt-2 space-y-0.5 font-mono text-xs">
                    {actions.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {isCustom && canDelete ? (
        <section className="border-t border-[color:var(--color-border)] pt-6">
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-error)] uppercase">
            Danger zone
          </h2>
          <div className="mt-3 flex items-start justify-between gap-4 rounded-md border border-[color:var(--color-error)]/40 bg-[color:var(--color-error)]/5 p-4">
            <p className="flex-1 text-sm text-[color:var(--color-fg-muted)]">
              Delete this role. The action is refused while any user still holds it — revoke the
              assignments first. OIDC group mappings that reference this slug will become unresolved
              on the next sign-in.
            </p>
            <DeleteRoleButton
              roleId={role.id}
              roleName={role.name}
              assignmentCount={assignmentCount}
            />
          </div>
        </section>
      ) : null}

      {canReadAudit ? (
        <AdminAuditPanel
          entries={recentEdits}
          fullHistoryHref={`/admin/audit?resourceType=role&resourceId=${encodeURIComponent(id)}`}
        />
      ) : null}
    </div>
  );
}

function groupByResource(permissions: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const perm of permissions) {
    const dot = perm.indexOf(".");
    const resource = dot === -1 ? perm : perm.slice(0, dot);
    const action = dot === -1 ? "" : perm.slice(dot + 1);
    (out[resource] ??= []).push(action);
  }
  for (const arr of Object.values(out)) arr.sort();
  return out;
}
