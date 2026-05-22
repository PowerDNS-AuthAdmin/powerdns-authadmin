/**
 * lib/validators/settings.ts
 *
 * Schema for the runtime-mutable app settings. The settings table is `jsonb`
 * per-key, so each known key has its own typed shape — listed in
 * `KNOWN_SETTING_KEYS` below.
 *
 * Adding a setting:
 *   1. Add the key to KNOWN_SETTING_KEYS.
 *   2. Add a Zod schema for its value to SETTING_VALUE_SCHEMAS.
 *   3. Add it to settingsResponseSchema's output shape.
 *   4. Surface the form field in the admin Settings page.
 *
 * Unknown keys are rejected at the route boundary, so adding storage isn't
 * enough — you have to wire the schema here too.
 */

import "server-only";
import { z } from "zod";

/** Keys the application recognizes. The admin form edits these by name. */
export const KNOWN_SETTING_KEYS = [
  "site_name",
  "brand_logo_url",
  "support_contact",
  "login_intro",
  // Account lockout policy (S-13 follow-up). Tunable from the
  // admin Settings page so security-sensitive operators can tighten
  // or relax the defaults without a code change. Defaults
  // documented in SETTING_DEFAULTS_TYPED below.
  "login_lockout_threshold",
  "login_lockout_seconds",
  // Self-service password reset (the "Forgot password?" flow). Off hides the
  // login-page link and makes the forgot-password endpoint a no-op. Local
  // accounts only — SSO users reset through their IdP.
  "allow_password_reset",
] as const;

export type KnownSettingKey = (typeof KNOWN_SETTING_KEYS)[number];

/**
 * Per-key value validators. `parse` runs over the row's `value` jsonb when
 * the API serializes it; `safeParse` on input from the admin form.
 *
 * `brand_logo_url` accepts either an absolute `https://` URL or an inline
 * `data:image/...` URI (so the upload widget in the settings form can stash
 * the image directly in the row without us needing object storage yet).
 * The size cap below covers a ~1.5 MB raw image — generous for a logo,
 * small enough to keep the row from bloating the audit `before`/`after`
 * snapshots when settings change.
 *
 * Only raster data: MIME types are allowed (png/jpeg/gif/webp). SVG is
 * deliberately excluded: an `image/svg+xml` document can carry `<script>`
 * and event handlers, so an inline SVG logo rendered into the page is a
 * stored-XSS vector. Raster formats can't execute, so they're safe to
 * inline. Externally hosted https:// SVGs remain allowed because the
 * browser fetches them as images (not active documents) under our CSP.
 */
const MAX_BRAND_LOGO_LENGTH = 2 * 1024 * 1024;

export const SETTING_VALUE_SCHEMAS = {
  site_name: z.string().min(1).max(120),
  brand_logo_url: z
    .string()
    .min(1)
    .max(
      MAX_BRAND_LOGO_LENGTH,
      "Logo is too large. Use an image under ~1.5 MB or host it externally.",
    )
    .refine(
      (u) =>
        u.startsWith("https://") ||
        u.startsWith("http://") ||
        // svg+xml is intentionally NOT accepted here: an inline SVG can
        // execute script when rendered, so only non-executable raster
        // formats are allowed as data: URIs.
        /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(u),
      {
        message:
          "Logo URL must use https://, http://, or be an inline data: URI (image/png, image/jpeg, image/gif, image/webp).",
      },
    ),
  support_contact: z.string().min(1).max(500),
  login_intro: z.string().max(2000),
  // Number-of-failed-attempts before lockout. 1 is degenerate but
  // technically valid; 100 is the practical ceiling (beyond that
  // online brute-force becomes economical regardless).
  login_lockout_threshold: z.coerce.number().int().min(1).max(100),
  // Lockout duration in seconds. 60s to 24h. Numbers chosen so any
  // sane operator value lies in-bounds and clearly-wrong values
  // (negative, zero, way-too-long) reject at the validator.
  login_lockout_seconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(24 * 60 * 60),
  allow_password_reset: z.boolean(),
} satisfies Record<KnownSettingKey, z.ZodTypeAny>;

/**
 * Full shape returned by `GET /api/admin/settings`. Every key is optional —
 * absent means "use the default at render time".
 */
export const settingsResponseSchema = z.object({
  site_name: z.string().optional(),
  brand_logo_url: z.string().optional(),
  support_contact: z.string().optional(),
  login_intro: z.string().optional(),
  login_lockout_threshold: z.number().int().optional(),
  login_lockout_seconds: z.number().int().optional(),
  allow_password_reset: z.boolean().optional(),
});

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/**
 * Patch shape accepted by `PATCH /api/admin/settings`. Each field is
 * optional; passing an explicit `null` deletes the row.
 */
export const updateSettingsSchema = z.object({
  site_name: z.union([SETTING_VALUE_SCHEMAS.site_name, z.null()]).optional(),
  brand_logo_url: z.union([SETTING_VALUE_SCHEMAS.brand_logo_url, z.null()]).optional(),
  support_contact: z.union([SETTING_VALUE_SCHEMAS.support_contact, z.null()]).optional(),
  login_intro: z.union([SETTING_VALUE_SCHEMAS.login_intro, z.null()]).optional(),
  login_lockout_threshold: z
    .union([SETTING_VALUE_SCHEMAS.login_lockout_threshold, z.null()])
    .optional(),
  login_lockout_seconds: z
    .union([SETTING_VALUE_SCHEMAS.login_lockout_seconds, z.null()])
    .optional(),
  allow_password_reset: z.union([SETTING_VALUE_SCHEMAS.allow_password_reset, z.null()]).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/** Defaults rendered when a setting row doesn't exist. */
export const SETTING_DEFAULTS: Required<SettingsResponse> = {
  site_name: "PowerDNS-AuthAdmin",
  brand_logo_url: "",
  support_contact: "",
  login_intro: "",
  // Matches the previous hardcoded constants in
  // `lib/auth/providers/local.ts` so existing deployments see no
  // behavior change until an operator tunes the values.
  login_lockout_threshold: 10,
  login_lockout_seconds: 15 * 60,
  // Self-service password reset is on by default (matches prior behavior).
  allow_password_reset: true,
};
