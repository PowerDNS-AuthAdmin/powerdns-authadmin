/**
 * lib/validators/common.ts
 *
 * Zod fragments shared across the per-feature validators. Dependency-free
 * (no "server-only") so both server schemas and any client-side typing can
 * import them.
 */

import { z } from "zod";

/**
 * URL-safe slug: lowercase alphanumerics with internal dashes, no leading or
 * trailing dash, 1–64 chars. Used for team / OIDC-provider / PDNS-server /
 * zone-template slugs.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const slugSchema = z
  .string()
  .min(1, "Slug is required.")
  .max(64, "Slug must be 64 characters or fewer.")
  .regex(
    SLUG_PATTERN,
    "Slug must use lowercase letters, digits, and dashes only (no leading or trailing dash).",
  );

/**
 * DNS TTL: a 32-bit unsigned integer of seconds. Shared by the RRset and
 * zone-template record validators.
 */
export const ttlSchema = z
  .number()
  .int()
  .min(0, "TTL must be ≥ 0.")
  .max(2_147_483_647, "TTL is too large.");
