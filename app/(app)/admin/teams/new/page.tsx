/**
 * app/(app)/admin/teams/new/page.tsx
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateTeamForm } from "../_components/create-team-form";

export const metadata: Metadata = { title: "Add team" };

export default async function NewTeamPage() {
  await requireUserForPage({ can: "team.create" });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add team</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Teams own zones and group users with a shared access scope.
        </p>
      </header>
      <CreateTeamForm />
    </div>
  );
}
