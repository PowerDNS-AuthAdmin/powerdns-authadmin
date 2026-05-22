/**
 * lib/validators/roles.ts
 *
 * Zod schemas for the custom-role admin routes. Permission strings are
 * validated against the master vocabulary in `lib/rbac/permissions.ts`
 * so an operator can't accidentally store a typo'd permission.
 */

import "server-only";
import { z } from "zod";
import { PERMISSIONS } from "@/lib/rbac/permissions";

/** Lowercase kebab slug. Matches the convention enforced for system roles. */
const slugRegex = /^[a-z][a-z0-9-]*$/;

/**
 * z.enum needs a non-empty tuple of literal strings at compile time. The
 * runtime PERMISSIONS array is `as const` so we can cast it without loss
 * of safety: every string in the cast already comes from the canonical
 * `Permission` literal union.
 */
const permissionEnum = z.enum(PERMISSIONS as unknown as [string, ...string[]]);

export const createRoleSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(
        slugRegex,
        "Slug must start with a letter and contain only lowercase letters, digits, and hyphens.",
      ),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    requiresMfa: z.boolean().default(false),
    permissions: z.array(permissionEnum).min(1, "At least one permission is required."),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.union([z.string().max(2000), z.null()]).optional(),
    requiresMfa: z.boolean().optional(),
    permissions: z.array(permissionEnum).min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
