/**
 * lib/db/schema-sqlite/team-members.ts - SQLite mirror of `../schema/team-members.ts`.
 *
 * SQLite has no enum type; team_role is text with a CHECK constraint.
 */

import { sql } from "drizzle-orm";
import { check, index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { teams } from "./teams";
import { users } from "./users";
import { timestamps } from "./_helpers";

export const teamMembers = sqliteTable(
  "team_members",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    teamRole: text("team_role").notNull().default("member"),
    ...timestamps(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.teamId] }),
    teamIdx: index("team_members_team_idx").on(t.teamId),
    teamRoleCheck: check("team_members_team_role_check", sql`${t.teamRole} IN ('owner','member')`),
  }),
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
