/**
 * lib/rbac/policy.ts
 *
 * The thin layer route handlers use. Routes don't talk to CASL directly -
 * they call `can()` or `requirePermission()` and don't need to know that the
 * implementation underneath is CASL.
 *
 * Why this wrapper:
 *   - Keeps CASL out of route handler code, so swapping the engine is a
 *     `lib/rbac/` change, not an app-wide change.
 *   - Standardizes the error type (`ForbiddenError`), giving the HTTP layer
 *     one place to map authz failures to 403.
 *   - Provides a typed action/subject vocabulary that matches our permissions.
 */

import "server-only";
import { ForbiddenError } from "@/lib/errors";
import type { AppAbility, Subject } from "./ability";

/**
 * True if the ability grants `action` on `subject`. Identical to
 * `ability.can()`; provided so callers don't import CASL types directly.
 */
export function can(ability: AppAbility, action: string, subject: Subject): boolean {
  return ability.can(action, subject);
}

/**
 * Throw `ForbiddenError` if the ability doesn't grant `action` on `subject`.
 * The HTTP layer maps it to 403.
 *
 * @example
 *   await requirePermission(ability, "delete", { __type: "Zone", id, teamId });
 */
export function requirePermission(ability: AppAbility, action: string, subject: Subject): void {
  if (!ability.can(action, subject)) {
    throw new ForbiddenError(
      `Missing permission: ${action} on ${typeof subject === "string" ? subject : subject.__type}`,
    );
  }
}
