/**
 * app/(app)/admin/settings/page.tsx
 *
 * Runtime-mutable app settings — site name, branding, login intro text,
 * support contact. The values are stored in the `settings` table; static
 * config (DATABASE_URL, encryption keys, OIDC env fallback) stays env-only
 * and is intentionally not exposed here.
 *
 * Permission: settings.read to see, settings.write to edit (gated server-
 * side by the route handler).
 */

import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllSettings } from "@/lib/db/repositories/settings";
import { SETTING_DEFAULTS, type KnownSettingKey } from "@/lib/validators/settings";
import { SettingsForm } from "./_components/settings-form";

export default async function SettingsPage() {
  const { ability } = await requireUserForPage({ can: "settings.read" });
  const canWrite = ability.can("write", "Settings");
  const canReadOidc = ability.can("read", "Oidc");

  const rows = await listAllSettings();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  // String-typed fields. Each defaults to "" when the row is missing
  // so the form can map "" → null on submit (delete the row →
  // server falls back to its default).
  function readString(
    key: KnownSettingKey & ("site_name" | "brand_logo_url" | "support_contact" | "login_intro"),
  ): string {
    const v = byKey.get(key);
    return typeof v === "string" ? v : SETTING_DEFAULTS[key];
  }
  function readNumber(
    key: KnownSettingKey & ("login_lockout_threshold" | "login_lockout_seconds"),
  ): number {
    const v = byKey.get(key);
    return typeof v === "number" ? v : SETTING_DEFAULTS[key];
  }
  function readBool(key: KnownSettingKey & "allow_password_reset"): boolean {
    const v = byKey.get(key);
    return typeof v === "boolean" ? v : SETTING_DEFAULTS[key];
  }

  const initial = {
    site_name: readString("site_name"),
    brand_logo_url: readString("brand_logo_url"),
    support_contact: readString("support_contact"),
    login_intro: readString("login_intro"),
    login_lockout_threshold: readNumber("login_lockout_threshold"),
    login_lockout_seconds: readNumber("login_lockout_seconds"),
    allow_password_reset: readBool("allow_password_reset"),
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Runtime-mutable app settings.{" "}
          {canReadOidc ? (
            <>
              Identity-provider configuration lives on{" "}
              <Link href="/admin/oidc-providers" className="underline">
                OIDC providers
              </Link>
              .{" "}
            </>
          ) : null}
          Static infrastructure config (database URL, encryption keys, log level) is set via
          environment variables.
        </p>
      </header>

      <SettingsForm initial={initial} canWrite={canWrite} />
    </div>
  );
}
