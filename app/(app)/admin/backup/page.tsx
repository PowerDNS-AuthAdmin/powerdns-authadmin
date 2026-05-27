/**
 * app/(app)/admin/backup/page.tsx
 *
 * Backup admin surface (#84). Super-admin-gated. Exports the entire
 * app DB (no zone data) as a single JSON file. Restore is documented
 * but the wired-up UI lands in a follow-up — operators wanting to
 * restore today should use `pg_restore` / `sqlite3 .restore` against
 * the dump (the JSON format is operator-readable + scriptable).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { ForbiddenError } from "@/lib/errors";

export const metadata: Metadata = { title: "Backup" };

export default async function BackupPage() {
  const { globalPermissions } = await requireUserForPage();
  if (!globalPermissions.has("system.backup")) {
    throw new ForbiddenError("Missing system.backup.");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Backup</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Export the app database as a single JSON file for disaster recovery, migration to a new
          host, or pre-upgrade snapshotting.
        </p>
      </header>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
        <h2 className="mb-2 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          What's in the export
        </h2>
        <ul className="space-y-1 text-sm">
          <li>Every app-managed table: users, teams, roles, role assignments, zone grants.</li>
          <li>Auth provider configurations: OIDC, SAML, and LDAP rows.</li>
          <li>Backend topology: PDNS servers, clusters, autoprimary advisories.</li>
          <li>Settings, zone templates, API tokens.</li>
          <li>Most recent 10,000 audit log entries.</li>
        </ul>
        <h2 className="mt-5 mb-2 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          What's NOT in the export
        </h2>
        <ul className="space-y-1 text-sm">
          <li>
            <strong>Zone data</strong> — PDNS owns it. Use AXFR or zonefile export (see{" "}
            <Link href="/zones" className="underline">
              Zones
            </Link>
            ) for that.
          </li>
          <li>
            <strong>APP_SECRET_KEY</strong> and <strong>APP_ENCRYPTION_KEY</strong> — these stay
            environment-side. Encrypted columns in the export (OIDC client secret, SAML SP private
            key, LDAP bind password, refresh tokens) are exported as ciphertext and are useless
            without the encryption key.
          </li>
        </ul>
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
        <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Export
        </h2>
        <p className="mb-4 text-sm">
          Clicking the button below will stream a JSON file named{" "}
          <code className="font-mono">pda-backup-YYYY-MM-DD.json</code>. The export is audited as{" "}
          <code className="font-mono">system.backup.exported</code> with per-table row counts in the
          audit payload.
        </p>
        <a
          href="/api/admin/backup/export"
          className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Download backup
        </a>
      </section>

      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
        <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Restoring
        </h2>
        <p className="text-sm">
          The interactive restore flow lands in a follow-up release. Today, recovering an instance
          from the JSON export is a scripted operation:
        </p>
        <ol className="mt-3 space-y-2 text-sm">
          <li>
            <strong>1.</strong> Bring up a fresh instance with the <em>same</em>{" "}
            <code className="font-mono">APP_ENCRYPTION_KEY</code> as the source — without it the
            encrypted columns (provider secrets, refresh tokens) are unusable.
          </li>
          <li>
            <strong>2.</strong> Run the migrations to create the v1.3.0 schema:{" "}
            <code className="font-mono">npm run db:migrate</code>.
          </li>
          <li>
            <strong>3.</strong> For each <code className="font-mono">tables.&lt;name&gt;</code> in
            the export, <code className="font-mono">INSERT … ON CONFLICT DO NOTHING</code> (or{" "}
            <code className="font-mono">REPLACE INTO</code> for SQLite) the rows. The Postgres
            <code className="font-mono"> COPY FROM stdin</code> + per-table JSON-to-CSV step is
            scriptable in ~30 lines.
          </li>
          <li>
            <strong>4.</strong> Verify by signing in. Encrypted columns decrypt against the
            preserved <code className="font-mono">APP_ENCRYPTION_KEY</code>; admin-issued role
            assignments work immediately. SSO sessions need users to re-sign-in to repopulate{" "}
            <code className="font-mono">sessions.derived_permissions</code>.
          </li>
        </ol>
      </section>
    </div>
  );
}
