/**
 * lib/db/schema/zone-templates.ts
 *
 * Reusable zone scaffolds applied at "create zone" time. A template carries
 * the operational defaults a new zone almost always needs:
 *
 *   - SOA timers (refresh / retry / expire / minimum / TTL)
 *   - Default NS records — best-practice DNS publishes at least two
 *     authoritative servers (RFC 2182 § 5).
 *   - Optional "prelude" records the operator wants on every zone of this
 *     kind — common SPF/DMARC TXT, MX, CAA, etc.
 *
 * Records live in a `jsonb` array. Each entry is `{ name, type, ttl,
 * content }` — `name` is RELATIVE to the zone ("@" for apex, "www" for the
 * www subdomain). At apply time the editor expands them against the
 * concrete zone name.
 *
 * SOA primary NS (`mname`) and rname aren't stored on the template — they
 * derive from the operator's NS list + a zone-aware default mailbox when
 * the zone is created. That keeps the template generic across operators.
 */

import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export interface TemplateRecord {
  /** Relative name. "@" for the zone apex, "www" for www.<zone>, etc. */
  name: string;
  /** Uppercase RR type. */
  type: string;
  /** TTL in seconds. */
  ttl: number;
  /** Single content string per record (one record per row). */
  content: string;
  /** When true, applied as a disabled record (kept in zone but not served). */
  disabled?: boolean;
}

export const zoneTemplates = pgTable(
  "zone_templates",
  {
    id: pk(),

    /** URL-safe identifier — appears in `/admin/zone-templates/<slug>`. */
    slug: text("slug").notNull(),

    /** Display name for the picker on the create-zone page. */
    name: text("name").notNull(),

    description: text("description"),

    // --- SOA timer defaults --------------------------------------------------
    soaTtl: integer("soa_ttl").notNull().default(3600),
    soaRefresh: integer("soa_refresh").notNull().default(3600),
    soaRetry: integer("soa_retry").notNull().default(900),
    soaExpire: integer("soa_expire").notNull().default(604800),
    soaMinimum: integer("soa_minimum").notNull().default(3600),

    /**
     * Default authoritative name servers — fully-qualified hostnames. The
     * NS records on a newly-created zone are seeded from this list when no
     * operator override is supplied at create time.
     */
    nameservers: jsonb("nameservers").$type<string[]>().notNull().default([]),

    /** Prelude record list — applied on top of NS + SOA at create time. */
    records: jsonb("records").$type<TemplateRecord[]>().notNull().default([]),

    // --- Zone-object defaults ------------------------------------------------
    /**
     * Default zone kind applied at create time. Operator can still pick
     * a different kind on the create-zone form (it's the prefill). Stored
     * as text since PDNS accepts Native/Master/Slave/Primary/Secondary
     * /Producer/Consumer and aliases vary by version.
     */
    kind: text("kind").notNull().default("Native"),
    /** Default `soa_edit` for the zone-object PUT. */
    soaEdit: text("soa_edit"),
    /** Default `soa_edit_api`. */
    soaEditApi: text("soa_edit_api"),
    /** Default `api_rectify`. NULL means "don't touch / leave at server default." */
    apiRectify: boolean("api_rectify"),

    /**
     * Default metadata bag. Each key is a PDNS metadata kind, each value
     * the list of strings to seed. Applied via per-kind PUTs after the
     * zone is created — bypasses the metadata-API allowlist quirks (the
     * zone-create path already reaches into the backend directly anyway).
     */
    metadata: jsonb("metadata").$type<Record<string, string[]>>().notNull().default({}),

    /**
     * PDNS primary IDs this template is the "default for". When the
     * operator picks one of these primaries on the create-zone page, the
     * UI pre-selects this template. Multiple templates may list the same
     * primary; first match wins.
     */
    defaultForPrimaryIds: text("default_for_primary_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    /** Who added it; NULL once the creator's row is deleted. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("zone_templates_slug_idx").on(t.slug),
  }),
);

export type ZoneTemplate = typeof zoneTemplates.$inferSelect;
export type NewZoneTemplate = typeof zoneTemplates.$inferInsert;
