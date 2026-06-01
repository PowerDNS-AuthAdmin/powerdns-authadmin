/**
 * lib/auth/settings-lock.ts
 *
 * The `SETTINGS_RO` global lock for the admin Settings page. When enabled
 * (intended for a public demo where visitors may hold a settings-capable role),
 * every runtime-mutable app setting is frozen: site name, branding, login intro,
 * support contact, lockout policy, and the password-reset toggle. This stops a
 * visitor from reconfiguring a shared install without having to strip the
 * `settings.write` permission from the demo role.
 *
 * The lock is a pure env switch - no schema column, no migration - so it is a
 * no-op unless `SETTINGS_RO=true` and real deployments are entirely unaffected.
 *
 * Enforcement lives at the API route handler (the security boundary); the
 * matching UI affordance (disabled form + notice) is a convenience layer that
 * calls `isSettingsReadOnly` to avoid dead-end clicks.
 */

import { env } from "@/lib/env";
import { ForbiddenError } from "@/lib/errors";

/** Whether the Settings page is globally locked against edits. */
export function isSettingsReadOnly(): boolean {
  return env.SETTINGS_RO;
}

/**
 * Throw `ForbiddenError` when the Settings page is globally locked. Call this at
 * every route that mutates app settings, after the permission + CSRF checks.
 */
export function assertSettingsMutable(): void {
  if (isSettingsReadOnly()) {
    throw new ForbiddenError("Settings are read-only on this deployment and cannot be modified.");
  }
}
