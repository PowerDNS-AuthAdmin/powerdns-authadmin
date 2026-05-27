/**
 * lib/auth/webauthn/index.ts
 *
 * Runtime entry point for the WebAuthn server-side ceremony helpers.
 * Combines env-derived defaults (`WEBAUTHN_*`) with DB-resolved settings
 * (`site_name`) to produce the `ResolvedWebauthnConfig` shape that
 * `@simplewebauthn/server` consumes.
 *
 * Anything that NEEDS to be testable in isolation (the resolver logic
 * itself) lives in `./config.ts`; this module is the impure wiring that
 * reads env + settings. Keep it thin.
 */

import "server-only";
import { env } from "@/lib/env";
import { getAppSettings } from "@/lib/settings/app-settings";
import { resolveWebauthnConfig, type ResolvedWebauthnConfig } from "./config";

/**
 * Resolve the live WebAuthn config for THIS request. Reads `settings.site_name`
 * via the cached `getAppSettings()` helper. Cheap; safe to call once per
 * ceremony.
 */
export async function getWebauthnConfig(): Promise<ResolvedWebauthnConfig> {
  const settings = await getAppSettings().catch(() => null);
  return resolveWebauthnConfig({
    appUrl: env.APP_URL,
    rpIdOverride: env.WEBAUTHN_RP_ID,
    rpNameOverride: env.WEBAUTHN_RP_NAME,
    siteName: settings?.siteName ?? null,
    userVerification: env.WEBAUTHN_USER_VERIFICATION,
    attestation: env.WEBAUTHN_ATTESTATION,
    allowInsecureOrigins: env.WEBAUTHN_ALLOW_INSECURE_ORIGINS,
  });
}

/** Re-export so callers don't reach into ./config directly. */
export type { ResolvedWebauthnConfig } from "./config";
