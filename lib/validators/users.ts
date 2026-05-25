/**
 * lib/validators/users.ts
 *
 * Shared Zod schemas for user-management routes and forms.
 */

import "server-only";
import { z } from "zod";
// Re-exported from a client-safe module so client forms can mirror the policy
// without pulling this `server-only` module into a client bundle (issue #32).
import { MIN_PASSWORD_LENGTH } from "./password-policy";

export { MIN_PASSWORD_LENGTH };

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(1024, "Password is too long.");

export const emailSchema = z
  .string()
  .email("Enter a valid email address.")
  .max(320, "Email is too long.");

// =============================================================================
// Profile — change password (self-service)
// =============================================================================

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
    // Cloudflare Turnstile response token. Required by the route when
    // TURNSTILE_SECRET_KEY is configured; the schema accepts it
    // unconditionally so dev clients without the widget still validate
    // and the route decides whether enforcement applies.
    captchaToken: z.string().max(4096).optional(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const changeEmailRequestSchema = z.object({
  newEmail: emailSchema,
  currentPassword: z.string().min(1, "Enter your current password."),
});

export const changeEmailConfirmSchema = z.object({
  token: z.string().min(1).max(4096),
});

// Self-service display-name edit. Distinct from the admin
// `updateUserSchema` so a future "users can also flip
// disabled/mustChangePassword on themselves" idea can't sneak in
// behind a shared schema.
export const profileNameSchema = z.object({
  // Accept empty string as a clear-to-null intent so the form
  // doesn't need a separate "remove" affordance.
  name: z
    .string()
    .max(120)
    .transform((s) => s.trim())
    .nullable(),
});

// =============================================================================
// Self-service signup (SIGNUP_ENABLED)
// =============================================================================

export const signupSchema = z.object({
  email: emailSchema,
  // Reuse the app-wide password policy (Argon2id + min length) so a self-service
  // signup can't set a weaker password than an admin-created account.
  password: passwordSchema,
  // Optional display name. Empty/whitespace is normalised to undefined so the
  // user row stores NULL rather than an empty string.
  name: z
    .string()
    .max(120, "Name is too long.")
    .transform((s) => s.trim())
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined)),
  // Cloudflare Turnstile response token. Required by the route when
  // TURNSTILE_SECRET_KEY is configured; accepted unconditionally so dev clients
  // without the widget still validate (the route decides enforcement).
  captchaToken: z.string().max(4096).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;

// =============================================================================
// Admin — create / update user
// =============================================================================

export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().min(1).max(120).optional(),
  /**
   * Optional initial password. When omitted, the user is created SSO-only
   * (no `passwordHash`) and can only sign in via an external IdP. When
   * provided, `mustChangePassword` is automatically set so the operator's
   * choice of password is a one-time bootstrap.
   */
  password: passwordSchema.optional(),
  /**
   * Optional initial role assignment at global scope. When provided,
   * the create route additionally checks the actor has `role.assign`
   * permission (creating a user doesn't itself imply you can grant
   * roles) and creates a global-scope role assignment in the same
   * audited transaction. Omit to create the user with no roles —
   * matches the pre-Tick-57 behavior where roles were a separate
   * follow-up action.
   */
  roleId: z.string().uuid().optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  disabled: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
  // Per-user MFA override: true = require, false = exempt, null = inherit from
  // roles. Supersedes role requiresMfa (and the SSO exemption) when set.
  mfaRequired: z.boolean().nullable().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// =============================================================================
// Admin — assign a role to a user
// =============================================================================

export const roleAssignmentSchema = z
  .object({
    roleId: z.string().uuid("Role id must be a UUID."),
    scopeType: z.enum(["global", "team", "zone", "server"]),
    scopeId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (data) =>
      data.scopeType === "global"
        ? data.scopeId == null
        : typeof data.scopeId === "string" && data.scopeId.length > 0,
    {
      message: "scopeId is required for non-global scopes.",
      path: ["scopeId"],
    },
  );

export type RoleAssignmentInput = z.infer<typeof roleAssignmentSchema>;
