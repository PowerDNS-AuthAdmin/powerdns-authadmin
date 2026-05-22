/**
 * lib/validators/pdns-servers.ts
 *
 * Shapes for create / update payloads on the PDNS server admin routes. Used
 * by the route handlers and exported for client-side typing.
 *
 * Error messages are user-facing and written as instructions.
 */

import "server-only";
import { z } from "zod";
import { slugSchema } from "./common";

/**
 * The PowerDNS HTTP API lives under `/api/v1/...` on every supported version.
 * Most operators only know the host + port (e.g. `http://pdns:8081`); making
 * them remember the `/api/v1` suffix is a footgun. We accept either form and
 * normalize on input:
 *   - "http://pdns:8081"          → "http://pdns:8081/api/v1"
 *   - "http://pdns:8081/"         → "http://pdns:8081/api/v1"
 *   - "http://pdns:8081/api/v1"   → "http://pdns:8081/api/v1"   (unchanged)
 *   - "http://pdns:8081/api/v1/"  → "http://pdns:8081/api/v1"   (slash stripped)
 *   - "http://pdns:8081/custom"   → "http://pdns:8081/custom"   (left alone — operator
 *      knows what they're doing, e.g. a reverse-proxied prefix)
 *
 * The transform runs after the URL shape + scheme checks, so by the time
 * downstream code (SSRF guard, encryption layer, PDNS client) reads the
 * stored value it's already normalized.
 */
const baseUrlSchema = z
  .string()
  .url("Base URL must be a full URL including scheme (e.g. https://pdns:8081).")
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "Base URL must use http:// or https://.",
  )
  .refine((value) => {
    // Credentials belong in the API key, never in the URL: a userinfo
    // component (`https://user:pass@host`) would leak into the request log
    // and audit snapshots and bypass the encrypted apiKey field.
    try {
      const parsed = new URL(value);
      return parsed.username === "" && parsed.password === "";
    } catch {
      // `.url()` already validated the shape; stay defensive.
      return true;
    }
  }, "Base URL must not contain a username or password — put credentials in the API key field.")
  .transform((value) => {
    const stripped = value.replace(/\/+$/, "");
    try {
      const parsed = new URL(stripped);
      // Only auto-append when no meaningful path is present. Operators with
      // a reverse-proxied prefix (e.g. /pdns/api/v1) pass through unchanged.
      if (parsed.pathname === "" || parsed.pathname === "/") {
        return `${stripped}/api/v1`;
      }
      return stripped;
    } catch {
      // Shouldn't happen — `.url()` already validated, but stay defensive.
      return stripped;
    }
  });

/**
 * Free-text operator note. Cap at 500 chars — enough for a couple
 * sentences ("dev box, do not edit between 09:00-17:00 UTC,
 * primary is X"); short enough to keep the row + audit snapshots
 * bounded. Empty submits as null (clears).
 */
const descriptionSchema = z
  .string()
  .max(500, "Description must be 500 characters or fewer.")
  .transform((s) => s.trim());

const roleSchema = z.enum(["primary", "secondary"]).default("primary");

export const createPdnsServerSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1, "Name is required.").max(120),
    description: descriptionSchema.optional(),
    baseUrl: baseUrlSchema,
    serverId: z.string().min(1).max(120).default("localhost"),
    apiKey: z.string().min(1, "API key is required.").max(2048, "API key is unexpectedly long."),
    isDefault: z.boolean().default(false),
    role: roleSchema,
    primaryId: z.string().uuid().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.role === "secondary" && !v.primaryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryId"],
        message: "Secondaries must reference a primary.",
      });
    }
    if (v.role === "primary" && v.primaryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryId"],
        message: "Primaries cannot reference a parent primary.",
      });
    }
    if (v.role === "secondary" && v.isDefault) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isDefault"],
        message: "Secondaries can't be the default backend — only primaries.",
      });
    }
  });

export type CreatePdnsServerInput = z.infer<typeof createPdnsServerSchema>;

/**
 * Update schema: every field optional. `apiKey` rotates the stored key when
 * provided; omit to leave the existing one in place. `disabledAt` flips the
 * soft-disable state — pass `true` to disable, `false` to re-enable.
 */
export const updatePdnsServerSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(120).optional(),
  // Send null to clear; send a string to set; omit to leave
  // unchanged. Matches the convention for the OIDC iconUrl /
  // settings null-clears.
  description: z.union([descriptionSchema, z.null()]).optional(),
  baseUrl: baseUrlSchema.optional(),
  serverId: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(1).max(2048).optional(),
  isDefault: z.boolean().optional(),
  disabled: z.boolean().optional(),
  // Role / primaryId can be flipped on the edit form; the route
  // re-validates the same primary↔secondary invariants the create
  // schema enforces.
  role: z.enum(["primary", "secondary"]).optional(),
  primaryId: z.string().uuid().optional().nullable(),
});

export type UpdatePdnsServerInput = z.infer<typeof updatePdnsServerSchema>;
