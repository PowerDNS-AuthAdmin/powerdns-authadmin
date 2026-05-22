/**
 * app/(app)/admin/teams/page.tsx
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { countMembersByTeam, listAllTeams } from "@/lib/db/repositories/teams";
import { latestAdminEditTimestampsForTeams } from "@/lib/db/repositories/audit-log";
import { TeamsTable, type TeamRow } from "./_components/teams-table";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsListPage() {
  const { ability } = await requireUserForPage({ can: "team.read" });
  const teams = await listAllTeams();
  const counts = await countMembersByTeam(teams.map((t) => t.id));
  const canCreate = ability.can("create", "Team");
  const canReadAudit = ability.can("read", "Audit");
  const lastEdits =
    canReadAudit && teams.length > 0
      ? await latestAdminEditTimestampsForTeams(teams.map((t) => t.id))
      : new Map<string, Date>();

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Teams</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            {teams.length} team{teams.length === 1 ? "" : "s"}.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/admin/teams/new"
            className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
          >
            Add team
          </Link>
        ) : null}
      </header>

      {teams.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          No teams yet.
        </div>
      ) : (
        <TeamsTable
          showLastAdminEdit={canReadAudit}
          rows={teams.map(
            (t): TeamRow => ({
              id: t.id,
              name: t.name,
              slug: t.slug,
              memberCount: counts.get(t.id) ?? 0,
              lastAdminEditIso: lastEdits.get(t.id)?.toISOString() ?? null,
            }),
          )}
        />
      )}
    </div>
  );
}
