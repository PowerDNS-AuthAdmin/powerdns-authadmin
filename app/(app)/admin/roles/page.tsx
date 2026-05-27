/**
 * app/(app)/admin/roles/page.tsx
 *
 * Lists seeded system roles + custom roles with their permission counts.
 * Custom roles are creatable / editable / deletable from here (gated by
 * the role.{create,update,delete} permissions); system roles are
 * read-only except for the per-role MFA toggle on the detail page.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listRoles } from "@/lib/db/repositories/roles";
import { latestAdminEditTimestampsForRoles } from "@/lib/db/repositories/audit-log";
import { RolesTable, type RoleRow } from "./_components/roles-table";

export const metadata: Metadata = { title: "Roles" };

export default async function RolesListPage() {
  const { ability } = await requireUserForPage({ can: "role.read" });
  const canReadAudit = ability.can("read", "Audit");
  const canCreate = ability.can("create", "Role");
  const roles = await listRoles();
  const lastEdits =
    canReadAudit && roles.length > 0
      ? await latestAdminEditTimestampsForRoles(roles.map((r) => r.id))
      : new Map<string, Date>();

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Seeded system roles plus any custom roles. System roles can&apos;t be edited or deleted
            (only the MFA-required toggle); custom roles support full CRUD.
          </p>
        </div>
        {canCreate ? <CreateButton href="/admin/roles/new" label="Add role" /> : null}
      </header>

      <RolesTable
        showLastAdminEdit={canReadAudit}
        rows={roles.map(
          (r): RoleRow => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            description: r.description,
            kind: r.isSystem ? "System" : "Custom",
            permissionCount: r.permissions.length,
            requiresMfa: r.requiresMfa,
            lastAdminEditIso: lastEdits.get(r.id)?.toISOString() ?? null,
          }),
        )}
      />
    </div>
  );
}
