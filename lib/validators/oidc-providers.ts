/**
 * lib/validators/oidc-providers.ts
 *
 * Zod schemas for the OIDC providers admin form.
 *
 * The `client_secret` field is shown plaintext at create time, then never
 * round-tripped to the client again - edit-mode treats it as optional;
 * omitting preserves the existing encrypted value.
 */

import "server-only";
import { z } from "zod";
import { slugSchema } from "./common";

const issuerUrlSchema = z
  .string()
  .url("Issuer URL must be a full URL including scheme (https://...).")
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "Issuer URL must use http:// or https://.",
  );

const claimSchema = z
  .string()
  .min(1, "Claim name is required.")
  .max(64, "Claim name is too long.")
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Claim name must be a valid identifier.");

const scopesSchema = z
  .string()
  .min(1, "At least one scope is required.")
  .max(500)
  .refine(
    (s) => s.split(/\s+/).every((tok) => /^[a-zA-Z0-9_:.-]+$/.test(tok)),
    "Scopes must be space-separated identifiers (e.g. 'openid profile email').",
  );

/**
 * Optional icon for the login button. Accepts an
 * absolute http(s) URL OR an inline `data:image/...` URI. The
 * size cap is intentionally tighter than the brand-logo
 * 2 MB ceiling - login-button icons are tiny (16-48px) and a
 * 64 KB base64 string is already overkill for an SVG/PNG that
 * size. Keeps the oidc_providers row small enough that audit
 * before/after snapshots don't bloat.
 */
const MAX_ICON_LENGTH = 64 * 1024;

const iconUrlSchema = z
  .string()
  .min(1)
  .max(MAX_ICON_LENGTH, "Icon is too large. Use an image under 64 KB or host it externally.")
  .refine(
    (u) =>
      u.startsWith("https://") ||
      u.startsWith("http://") ||
      /^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp);base64,/.test(u),
    {
      message: "Icon URL must use https://, http://, or be an inline data: URI.",
    },
  );

/**
 * Per-provider email-domain override (S-7).
 *
 *   null   → inherit env `OIDC_ALLOWED_EMAIL_DOMAINS`
 *   []     → "no restriction at this provider" (explicit override of env)
 *   [...]  → REPLACE env entirely with this list
 *
 * Each entry is a bare domain (no `@`), lower-cased on submit. Up to
 * 64 entries - that's well beyond any realistic operator need and
 * keeps a malicious admin from stuffing the column.
 */
const allowedEmailDomainsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(253)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
        "Each entry must be a bare domain (lowercase, no '@').",
      ),
  )
  .max(64, "At most 64 domains.")
  .nullable();

/**
 * Per-provider group → role-assignment rule. Mirrors the shape
 * persisted in `oidc_providers.group_mappings`. Resolved-at-sign-in,
 * stored as slugs (roles + teams + servers) for stability across
 * UUID changes; zone scope carries the canonical zone name.
 */
const groupMappingSchema = z
  .object({
    /** Exact group value to match. Case-sensitive. */
    group: z.string().min(1).max(500),
    /** Role slug (system or custom). */
    roleSlug: z.string().min(1).max(64),
    scopeType: z.enum(["global", "team", "zone", "server"]),
    /** Null when scopeType=global; slug or fqdn otherwise. */
    scopeId: z.string().min(1).max(255).nullable(),
  })
  .refine((m) => (m.scopeType === "global" ? m.scopeId === null : m.scopeId !== null), {
    message: "scopeId must be null for global scope and non-null for team/zone/server scope.",
  });

const groupMappingsSchema = z.array(groupMappingSchema).max(200).nullable();

export const createOidcProviderSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1, "Name is required.").max(120),
  issuerUrl: issuerUrlSchema,
  clientId: z.string().min(1, "Client ID is required.").max(500),
  clientSecret: z
    .string()
    .min(1, "Client secret is required.")
    .max(2048)
    // Strip stray leading/trailing whitespace introduced by clipboard
    // paste - the most common reason a verified-by-eye secret silently
    // mismatches the IdP. authentik / Keycloak / Okta secrets use a
    // URL-safe alphabet that never includes whitespace, so the trim
    // is non-destructive for every value the IdP would generate.
    .transform((s) => s.trim()),
  scopes: scopesSchema.default("openid profile email"),
  claimEmail: claimSchema.default("email"),
  claimName: claimSchema.default("name"),
  enabled: z.boolean().default(true),
  /** Default `true` - the account-takeover guard is on for new providers.
   *  Operators flip it off only for IdPs that don't emit `email_verified`
   *  at all (custom OIDC bridges, some SAML→OIDC translators). Existing DB
   *  rows keep their stored value; this default only applies at create time. */
  requireEmailVerified: z.boolean().default(true),
  allowedEmailDomains: allowedEmailDomainsSchema.optional(),
  iconUrl: iconUrlSchema.optional(),
  /** Per-provider group → role rules. Omit / null = no mappings. */
  groupMappings: groupMappingsSchema.optional(),
});

export type CreateOidcProviderInput = z.infer<typeof createOidcProviderSchema>;

export const updateOidcProviderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  issuerUrl: issuerUrlSchema.optional(),
  clientId: z.string().min(1).max(500).optional(),
  /** Omit to keep the existing secret; provide a new one to rotate.
   *  Trimmed before encryption - see the create schema's comment. */
  clientSecret: z
    .string()
    .min(1)
    .max(2048)
    .transform((s) => s.trim())
    .optional(),
  scopes: scopesSchema.optional(),
  claimEmail: claimSchema.optional(),
  claimName: claimSchema.optional(),
  enabled: z.boolean().optional(),
  requireEmailVerified: z.boolean().optional(),
  /** Per-provider group → role rules. Send `[]` to clear; omit to leave unchanged. */
  groupMappings: groupMappingsSchema.optional(),
  // Omit (undefined) to leave the field unchanged. Send null
  // explicitly to clear the override (revert to env inherit). Send
  // an array (possibly empty) to set the override.
  allowedEmailDomains: allowedEmailDomainsSchema.optional(),
  // `null` clears the icon (back to text-only button); array/string
  // sets it; undefined leaves unchanged.
  iconUrl: z.union([iconUrlSchema, z.null()]).optional(),
});

export type UpdateOidcProviderInput = z.infer<typeof updateOidcProviderSchema>;
