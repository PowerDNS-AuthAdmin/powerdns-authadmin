/**
 * app/(app)/admin/roles/new/page.tsx
 *
 * Create-custom-role page. Permission gate: `role.create`. The form lives
 * in `_components/role-form.tsx` and is shared with the edit flow.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { RoleForm } from "../_components/role-form";

export const metadata: Metadata = { title: "New role" };

export default async function NewRolePage() {
  await requireUserForPage({ can: "role.create" });
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
        <h1 className="text-2xl font-semibold tracking-tight">New role</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Custom roles bundle permissions an org needs in addition to the five seeded system roles.
          The slug you choose here is also what you reference in OIDC group → role mappings.
        </p>
      </header>
      <RoleForm mode="create" allPermissions={PERMISSIONS} />
    </div>
  );
}
