/**
 * app/(app)/admin/settings/page.tsx
 *
 * Runtime-mutable app settings - site name, branding, login intro text,
 * support contact. The values are stored in the `settings` table; static
 * config (DATABASE_URL, encryption keys, OIDC env fallback) stays env-only
 * and is intentionally not exposed here.
 *
 * Permission: settings.read to see, settings.write to edit (gated server-
 * side by the route handler).
 */

import Link from "next/link";
import { Database } from "lucide-react";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllSettings } from "@/lib/db/repositories/settings";
import { SETTING_DEFAULTS, type KnownSettingKey } from "@/lib/validators/settings";
import { SettingsForm } from "./_components/settings-form";

export default async function SettingsPage() {
  const { ability, globalPermissions } = await requireUserForPage({ can: "settings.read" });
  const canWrite = ability.can("write", "Settings");
  const canReadAuth = ability.can("read", "Auth");
  const canBackup = globalPermissions.has("system.backup");

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
          {canReadAuth ? (
            <>
              Identity-provider configuration lives on{" "}
              <Link href="/admin/authentication" className="underline">
                Authentication
              </Link>
              .{" "}
            </>
          ) : null}
          Static infrastructure config (database URL, encryption keys, log level) is set via
          environment variables.
        </p>
      </header>

      <SettingsForm initial={initial} canWrite={canWrite} />

      {canBackup ? (
        <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
          <div className="flex items-start gap-4">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
              <Database className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Backup &amp; Restore</h2>
              <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
                Snapshot the app database as a JSON file or merge one back in. Super-admin gated;
                excludes PDNS zone data and the symmetric secrets.
              </p>
            </div>
            <Link
              href="/admin/settings/backup"
              className="shrink-0 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5 text-sm font-medium hover:bg-[color:var(--color-bg-muted)]"
            >
              Open
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
