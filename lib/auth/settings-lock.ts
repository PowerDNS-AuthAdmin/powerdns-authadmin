/**
 * lib/auth/settings-lock.ts
 *
 * The `SETTINGS_RO` global lock for the admin Settings area. When enabled
 * (intended for a public demo where visitors may hold a settings-capable role),
 * every runtime-mutable app setting is frozen: site name, branding, login intro,
 * support contact, lockout policy, and the password-reset toggle. Settings DB
 * backup/restore is also disabled so the lock covers the whole settings
 * administration surface. This stops a visitor from reconfiguring or snapshotting
 * a shared install without having to strip admin permissions from the demo role.
 *
 * The lock is a pure env switch - no schema column, no migration - so it is a
 * no-op unless `SETTINGS_RO=true` and real deployments are entirely unaffected.
 *
 * Enforcement lives at the API route handler (the security boundary); the
 * matching UI affordances (disabled form/actions + notices) are convenience
 * layers that call `isSettingsReadOnly` to avoid dead-end clicks.
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

/**
 * Throw `ForbiddenError` when settings backup/restore is globally locked. The
 * backup endpoints are separate from PATCH /settings, but they expose or mutate
 * settings-area state and must obey the same deployment hardening switch.
 */
export function assertSettingsBackupAllowed(): void {
  if (isSettingsReadOnly()) {
    throw new ForbiddenError("Settings backup and restore are disabled on this deployment.");
  }
}
