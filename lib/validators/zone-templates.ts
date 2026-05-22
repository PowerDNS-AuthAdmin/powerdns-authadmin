/**
 * lib/validators/zone-templates.ts
 *
 * Zod shapes for zone-template create/update payloads, plus pure helpers
 * the create-zone path uses to expand a template against a concrete zone
 * name.
 *
 * Validation is intentionally generous — the per-RR-type validators in
 * `lib/validators/rr-types/` already enforce RFC-compliance at the editor.
 * Here we just sanity-check the shape (non-empty, length caps) so a
 * malformed POST can't slip past Zod.
 */

import { z } from "zod";
import { slugSchema, ttlSchema } from "./common";

const hostnameSchema = z
  .string()
  .min(1)
  .max(254)
  .regex(
    /^[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?(?:\.[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?)*\.?$/,
    "Looks malformed for a hostname.",
  );

const templateRecordSchema = z.object({
  /** Relative name, "@", or fully-qualified. Server normalizes at apply. */
  name: z.string().min(1).max(255),
  type: z
    .string()
    .min(1)
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,12}$/)),
  ttl: ttlSchema,
  content: z
    .string()
    .min(1)
    .max(65535)
    .refine((s) => !s.includes("\n"), "Records cannot contain newlines."),
  disabled: z.boolean().optional(),
});

const ZONE_KIND_VALUES = [
  "Native",
  "Master",
  "Slave",
  "Primary",
  "Secondary",
  "Producer",
  "Consumer",
] as const;

/** Zone metadata bag — keyed by PDNS metadata kind (`ALLOW-AXFR-FROM`, …). */
const metadataBagSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9-]*$/, "Metadata kinds must be uppercase letters/digits/hyphens."),
  z.array(z.string().max(2048)).max(256),
);

export const createZoneTemplateSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  soaTtl: z.number().int().min(0).default(3600),
  soaRefresh: z.number().int().min(0).default(3600),
  soaRetry: z.number().int().min(0).default(900),
  soaExpire: z.number().int().min(0).default(604800),
  soaMinimum: z.number().int().min(0).default(3600),
  nameservers: z.array(hostnameSchema).max(13).default([]),
  records: z.array(templateRecordSchema).max(500).default([]),
  kind: z.enum(ZONE_KIND_VALUES).default("Native"),
  soaEdit: z.string().max(64).optional().nullable(),
  soaEditApi: z.string().max(64).optional().nullable(),
  apiRectify: z.boolean().optional().nullable(),
  metadata: metadataBagSchema.default({}),
  defaultForPrimaryIds: z.array(z.string().uuid()).max(64).default([]),
});

export type CreateZoneTemplateInput = z.infer<typeof createZoneTemplateSchema>;

export const updateZoneTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  soaTtl: z.number().int().min(0).optional(),
  soaRefresh: z.number().int().min(0).optional(),
  soaRetry: z.number().int().min(0).optional(),
  soaExpire: z.number().int().min(0).optional(),
  soaMinimum: z.number().int().min(0).optional(),
  nameservers: z.array(hostnameSchema).max(13).optional(),
  records: z.array(templateRecordSchema).max(500).optional(),
  kind: z.enum(ZONE_KIND_VALUES).optional(),
  soaEdit: z.string().max(64).optional().nullable(),
  soaEditApi: z.string().max(64).optional().nullable(),
  apiRectify: z.boolean().optional().nullable(),
  metadata: metadataBagSchema.optional(),
  defaultForPrimaryIds: z.array(z.string().uuid()).max(64).optional(),
});

export type UpdateZoneTemplateInput = z.infer<typeof updateZoneTemplateSchema>;

/**
 * Expand a template's relative record names against a fully-qualified zone
 * name. "@" → zone, "www" → "www.<zone>.", already-qualified names ending
 * in "." pass through unchanged.
 */
export function expandTemplateName(relative: string, zoneName: string): string {
  const trimmed = relative.trim().toLowerCase();
  const fqZone = zoneName.endsWith(".") ? zoneName : `${zoneName}.`;
  if (trimmed === "" || trimmed === "@") return fqZone;
  if (trimmed.endsWith(".")) return trimmed;
  return `${trimmed}.${fqZone}`;
}
