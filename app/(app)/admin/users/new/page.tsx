/**
 * app/(app)/admin/users/new/page.tsx
 *
 * Create a new user account.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listRoles } from "@/lib/db/repositories/roles";
import { CreateUserForm } from "../_components/create-user-form";

export const metadata: Metadata = { title: "Add user" };

export default async function NewUserPage() {
  const { ability } = await requireUserForPage({ can: "user.create" });
  // Only offer the initial-role picker when the operator can
  // actually grant roles. Otherwise hide it entirely so a
  // `user.create`-only operator doesn't see an option they can't
  // use (which the server would reject).
  const canAssignRole = ability.can("assign", "Role");
  const roles = canAssignRole ? await listRoles() : [];
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add user</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Create a local account (with a one-time bootstrap password) or an SSO-only account that
          signs in exclusively through your identity provider.
        </p>
      </header>
      <CreateUserForm roles={roles.map((r) => ({ id: r.id, name: r.name, slug: r.slug }))} />
    </div>
  );
}
