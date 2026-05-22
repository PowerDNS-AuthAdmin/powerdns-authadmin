/**
 * lib/db/schema/teams.ts
 *
 * "Team" is the unit of multi-team RBAC. A team owns zones and groups users
 * with a shared scope of access.
 *
 * Slug is the URL-safe identifier (`/teams/<slug>`); name is the display form.
 * We separate them so renaming a team doesn't break URLs / API tokens scoped
 * to that team.
 */

import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_helpers";

export const teams = pgTable(
  "teams",
  {
    id: pk(),

    // URL-safe slug. Match regex: /^[a-z0-9](-?[a-z0-9])*$/, 1-64 chars.
    // Enforced at the validator layer; the DB keeps a uniqueness constraint.
    slug: text("slug").notNull(),

    // Display name.
    name: text("name").notNull(),
    description: text("description"),

    // Free-form contact info; surfaced in the team detail page.
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
