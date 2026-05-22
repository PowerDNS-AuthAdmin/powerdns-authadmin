/**
 * lib/db/schema-sqlite/zone-templates.ts — SQLite mirror of `../schema/zone-templates.ts`.
 *
 * Postgres' `text[]` for default_for_primary_ids becomes a JSON array in SQLite
 * — same JS shape, just a different storage encoding.
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export interface TemplateRecord {
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled?: boolean;
}

export const zoneTemplates = sqliteTable(
  "zone_templates",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    soaTtl: integer("soa_ttl").notNull().default(3600),
    soaRefresh: integer("soa_refresh").notNull().default(3600),
    soaRetry: integer("soa_retry").notNull().default(900),
    soaExpire: integer("soa_expire").notNull().default(604800),
    soaMinimum: integer("soa_minimum").notNull().default(3600),

    nameservers: text("nameservers", { mode: "json" }).$type<string[]>().notNull().default([]),
    records: text("records", { mode: "json" }).$type<TemplateRecord[]>().notNull().default([]),

    kind: text("kind").notNull().default("Native"),
    soaEdit: text("soa_edit"),
    soaEditApi: text("soa_edit_api"),
    apiRectify: integer("api_rectify", { mode: "boolean" }),

    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),

    defaultForPrimaryIds: text("default_for_primary_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("zone_templates_slug_idx").on(t.slug),
  }),
);

export type ZoneTemplate = typeof zoneTemplates.$inferSelect;
export type NewZoneTemplate = typeof zoneTemplates.$inferInsert;
