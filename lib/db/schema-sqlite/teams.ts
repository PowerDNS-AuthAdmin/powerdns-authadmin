/**
 * lib/db/schema-sqlite/teams.ts - SQLite mirror of `../schema/teams.ts`.
 */

import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pk, timestamps } from "./_helpers";

export const teams = sqliteTable(
  "teams",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    contact: text("contact"),
    mail: text("mail"),
    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("teams_slug_idx").on(t.slug),
    nameIdx: index("teams_name_idx").on(t.name),
  }),
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
