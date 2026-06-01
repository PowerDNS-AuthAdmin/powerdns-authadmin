/**
 * lib/db/schema/team-members.ts
 *
 * Membership join table - which users belong to which teams, and what their
 * team-level role is.
 *
 * `team_role` is a coarse marker for "can manage this team's settings/members".
 * Fine-grained capabilities (zone.read, record.update, etc.) come from
 * `role_assignments` with a `team:<id>` scope. The two are not redundant: team
 * membership grants visibility; role assignments grant capability.
 */

import { index, pgEnum, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams";
import { users } from "./users";
import { timestamps } from "./_helpers";

export const teamRoleEnum = pgEnum("team_role", ["owner", "member"]);

export const teamMembers = pgTable(
  "team_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    teamRole: teamRoleEnum("team_role").notNull().default("member"),
    ...timestamps(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.teamId] }),
    teamIdx: index("team_members_team_idx").on(t.teamId),
  }),
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
