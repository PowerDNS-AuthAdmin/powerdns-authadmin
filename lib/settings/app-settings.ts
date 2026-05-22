/**
 * lib/settings/app-settings.ts
 *
 * Server-side accessor for runtime-mutable app settings. Every page that
 * wants to render `site_name`, `brand_logo_url`, `support_contact`, or
 * `login_intro` calls `getAppSettings()` and reads the typed result —
 * nobody hits the repository directly.
 *
 * Defaults are applied here so callers get a non-null `siteName` always.
 * Falsy / missing rows collapse to "no override" (empty strings → null for
 * the URL/text fields).
 *
 * Failure mode: if the DB read throws (DB unreachable mid-request,
 * migrations not yet applied), we return defaults rather than 500. Settings
 * are decoration; the app should still render its core auth surface even
 * when the settings table is unhappy.
 */

import "server-only";
import { listAllSettings } from "@/lib/db/repositories/settings";
import { logger } from "@/lib/logger";
import { SETTING_DEFAULTS, type KnownSettingKey } from "@/lib/validators/settings";

export interface AppSettings {
  siteName: string;
  brandLogoUrl: string | null;
  supportContact: string | null;
  loginIntro: string | null;
  /**
   * Failed-login attempts before the user's account is locked out.
   * Read at every authentication attempt (`lib/auth/providers/
   * local.ts`); never null — defaults to 10 if the row is absent.
   */
  loginLockoutThreshold: number;
  /**
   * Lockout duration in seconds when the threshold is crossed.
   * Read at every authentication attempt. Never null; default 900s
   * (15 minutes).
   */
  loginLockoutSeconds: number;
  /**
   * Whether the self-service "Forgot password?" flow is available. Read by the
   * login page (to show/hide the link) and the forgot-password route (to no-op
   * when off). Never null — defaults to true.
   */
  allowPasswordReset: boolean;
}

const KEY_TO_FIELD: Record<KnownSettingKey, keyof AppSettings> = {
  site_name: "siteName",
  brand_logo_url: "brandLogoUrl",
  support_contact: "supportContact",
  login_intro: "loginIntro",
  login_lockout_threshold: "loginLockoutThreshold",
  login_lockout_seconds: "loginLockoutSeconds",
  allow_password_reset: "allowPasswordReset",
};

export async function getAppSettings(): Promise<AppSettings> {
  const out: AppSettings = {
    siteName: SETTING_DEFAULTS.site_name,
    brandLogoUrl: null,
    supportContact: null,
    loginIntro: null,
    loginLockoutThreshold: SETTING_DEFAULTS.login_lockout_threshold,
    loginLockoutSeconds: SETTING_DEFAULTS.login_lockout_seconds,
    allowPasswordReset: SETTING_DEFAULTS.allow_password_reset,
  };

  let rows;
  try {
    rows = await listAllSettings();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "app-settings.read-failed",
    );
    return out;
  }

  for (const row of rows) {
    const field = KEY_TO_FIELD[row.key as KnownSettingKey];
    if (!field) continue;
    if (field === "siteName" && typeof row.value === "string") {
      out.siteName = row.value || SETTING_DEFAULTS.site_name;
    } else if (
      (field === "brandLogoUrl" || field === "supportContact" || field === "loginIntro") &&
      typeof row.value === "string"
    ) {
      out[field] = row.value || null;
    } else if (field === "loginLockoutThreshold" && typeof row.value === "number") {
      out.loginLockoutThreshold = row.value;
    } else if (field === "loginLockoutSeconds" && typeof row.value === "number") {
      out.loginLockoutSeconds = row.value;
    } else if (field === "allowPasswordReset" && typeof row.value === "boolean") {
      out.allowPasswordReset = row.value;
    }
  }

  return out;
}
