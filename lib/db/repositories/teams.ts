/**
 * lib/db/repositories/teams.ts
 *
 * Data access for `teams` + `team_members`. Pure queries - no auth, no
 * permission checks; the admin route handlers gate the calls.
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { teamMembers, type NewTeamMember, type TeamMember } from "@/lib/db/schema";
import { teams, type NewTeam, type Team } from "@/lib/db/schema";
import { users } from "@/lib/db/schema";
import { countStar } from "@/lib/db/sql-dialect";

/** Every team, alphabetical by name. */
export async function listAllTeams(): Promise<Team[]> {
  return db.select().from(teams).orderBy(teams.name);
}

export async function findTeamById(id: string): Promise<Team | null> {
  const rows = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findTeamBySlug(slug: string): Promise<Team | null> {
  const rows = await db.select().from(teams).where(eq(teams.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function insertTeam(input: NewTeam, executor: DbExecutor = db): Promise<Team> {
  const rows = await executor.insert(teams).values(input).returning();
  if (!rows[0]) throw new Error("teams insert returned no row.");
  return rows[0];
}

export async function updateTeam(
  id: string,
  patch: Partial<Omit<Team, "id" | "createdAt">>,
  executor: DbExecutor = db,
): Promise<Team | null> {
  const rows = await executor
    .update(teams)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(teams.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteTeam(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(teams).where(eq(teams.id, id));
}

/**
 * Members of a team joined with the user row's display fields. Empty array
 * for an unknown team - callers should check team existence separately.
 */
export async function listTeamMembers(teamId: string): Promise<
  Array<{
    userId: string;
    email: string;
    name: string | null;
    teamRole: TeamMember["teamRole"];
    addedAt: Date;
  }>
> {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      teamRole: teamMembers.teamRole,
      addedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(users.name);
}

/** Add a user to a team. Caller deduplicates against the primary key. */
export async function addTeamMember(
  input: NewTeamMember,
  executor: DbExecutor = db,
): Promise<TeamMember> {
  const rows = await executor.insert(teamMembers).values(input).returning();
  if (!rows[0]) throw new Error("team_members insert returned no row.");
  return rows[0];
}

/** Update a member's team-level role (owner / member). */
export async function updateTeamMemberRole(
  teamId: string,
  userId: string,
  teamRole: TeamMember["teamRole"],
  executor: DbExecutor = db,
): Promise<TeamMember | null> {
  const rows = await executor
    .update(teamMembers)
    .set({ teamRole, updatedAt: new Date() })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

/** Remove a user from a team. */
export async function removeTeamMember(
  teamId: string,
  userId: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
}

/** Member counts keyed by team id - used by the team list view. */
export async function countMembersByTeam(teamIds: string[]): Promise<Map<string, number>> {
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select({
      teamId: teamMembers.teamId,
      count: countStar(),
    })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, teamIds))
    .groupBy(teamMembers.teamId);
  return new Map(rows.map((row) => [row.teamId, row.count]));
}
