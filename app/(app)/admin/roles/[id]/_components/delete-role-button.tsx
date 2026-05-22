"use client";

/**
 * app/(app)/admin/roles/[id]/_components/delete-role-button.tsx
 *
 * Confirm-then-DELETE button for a custom role. Surfaces the assignment count
 * so the operator sees up-front whether the delete will be blocked (the API
 * also enforces this server-side via a 409). Thin wrapper over the shared
 * <ConfirmDeleteButton>.
 */

import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";

interface Props {
  roleId: string;
  roleName: string;
  assignmentCount: number;
}

export function DeleteRoleButton({ roleId, roleName, assignmentCount }: Props) {
  return (
    <ConfirmDeleteButton
      endpoint={`/api/admin/roles/${roleId}`}
      confirmTitle={`Delete role "${roleName}"?`}
      confirmDescription={
        assignmentCount > 0
          ? `${assignmentCount} user${assignmentCount === 1 ? "" : "s"} still ${assignmentCount === 1 ? "holds" : "hold"} this role. The delete will be refused until the assignments are revoked.`
          : "This permanently removes the role. OIDC group mappings referencing its slug will become unresolved on next sign-in."
      }
      confirmLabel="Delete role"
      successMessage="Role deleted."
      label="Delete role"
      redirectTo="/admin/roles"
    />
  );
}
