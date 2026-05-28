"use client";

/**
 * app/(app)/admin/settings/backup/_components/backup-restore-wizard.tsx
 *
 * Multi-step super-admin wizard:
 *
 *   action picker  →  Backup branch  →  Download
 *                  →  Restore branch →  Upload → Confirm → Run → Result
 *
 * No modal — every step renders inline on the page with a back button.
 * Backup is one click; restore is gated behind a typed confirmation
 * because it's a destructive operation against the live DB.
 *
 * The restore endpoint is merge-only: every row inserts with
 * `ON CONFLICT DO NOTHING`, so a restore against a non-empty DB leaves
 * existing rows in place and only fills gaps. Replacing wholesale is
 * out of scope for this page; operators wanting a true wipe-and-replace
 * should `pg_restore` / `sqlite .restore` the DB directly.
 */

import { useRef, useState } from "react";
import { Download, Upload, ArrowLeft, ShieldCheck, AlertTriangle } from "lucide-react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

type Step = "choose" | "backup" | "restore-upload" | "restore-confirm" | "restore-result";

type RestoreCounts = Record<string, { attempted: number; inserted: number; skipped: number }>;

const CONFIRM_PHRASE = "RESTORE";

export function BackupRestoreWizard() {
  const [step, setStep] = useState<Step>("choose");
  const [file, setFile] = useState<File | null>(null);
  const [bundlePreview, setBundlePreview] = useState<{
    schemaVersion: number;
    appVersion: string;
    exportedAt: string;
    rowCountsByTable: Array<[string, number]>;
    totalRows: number;
  } | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [restoreCounts, setRestoreCounts] = useState<RestoreCounts | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useDialog();

  function resetTo(next: Step) {
    setStep(next);
    if (next === "choose") {
      setFile(null);
      setBundlePreview(null);
      setConfirmPhrase("");
      setRestoreCounts(null);
      setRestoreError(null);
    }
  }

  async function handleFile(picked: File) {
    setFile(picked);
    setRestoreError(null);
    try {
      const text = await picked.text();
      const parsed = JSON.parse(text) as {
        meta?: { schema_version?: number; app_version?: string; exported_at?: string };
        tables?: Record<string, unknown[]>;
      };
      if (parsed.meta?.schema_version !== 1) {
        setRestoreError(
          `Unsupported schema version (got ${String(parsed.meta?.schema_version ?? "unknown")}, expected 1).`,
        );
        setBundlePreview(null);
        return;
      }
      const tables = parsed.tables ?? {};
      const rowCountsByTable: Array<[string, number]> = Object.entries(tables)
        .map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : 0] as [string, number])
        .sort(([a], [b]) => a.localeCompare(b));
      const totalRows = rowCountsByTable.reduce((acc, [, n]) => acc + n, 0);
      setBundlePreview({
        schemaVersion: parsed.meta.schema_version,
        appVersion: parsed.meta.app_version ?? "(unknown)",
        exportedAt: parsed.meta.exported_at ?? "(unknown)",
        rowCountsByTable,
        totalRows,
      });
    } catch (err) {
      setRestoreError(
        `Could not parse the file as JSON: ${err instanceof Error ? err.message : "unknown error"}`,
      );
      setBundlePreview(null);
    }
  }

  async function handleRestore() {
    if (!file || !bundlePreview) return;
    if (confirmPhrase !== CONFIRM_PHRASE) return;
    setSubmitting(true);
    setRestoreError(null);
    try {
      const text = await file.text();
      const result = await mutate<{ counts?: RestoreCounts; error?: string }>(
        "/api/admin/backup/restore",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
        },
      );
      if (!result.ok) {
        setRestoreError(result.error || "Restore failed.");
        return;
      }
      setRestoreCounts(result.data?.counts ?? null);
      setStep("restore-result");
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Backup &amp; Restore</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Snapshot the app database for disaster recovery, migration to a new host, or pre-upgrade
          insurance.
        </p>
      </header>

      {step !== "choose" ? (
        <button
          type="button"
          onClick={() => resetTo("choose")}
          className="inline-flex items-center gap-1 text-sm text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </button>
      ) : null}

      {step === "choose" ? <ChoosePicker onPick={(next) => setStep(next)} /> : null}
      {step === "backup" ? <BackupStep onToast={(text) => toast({ kind: "success", description: text })} /> : null}
      {step === "restore-upload" ? (
        <RestoreUploadStep
          file={file}
          fileInputRef={fileInputRef}
          bundlePreview={bundlePreview}
          restoreError={restoreError}
          onPick={(f) => {
            void handleFile(f);
          }}
          onClear={() => {
            setFile(null);
            setBundlePreview(null);
            setRestoreError(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
          onNext={() => setStep("restore-confirm")}
        />
      ) : null}
      {step === "restore-confirm" ? (
        <RestoreConfirmStep
          bundlePreview={bundlePreview}
          confirmPhrase={confirmPhrase}
          onConfirmPhraseChange={setConfirmPhrase}
          onRun={() => void handleRestore()}
          submitting={submitting}
          restoreError={restoreError}
        />
      ) : null}
      {step === "restore-result" ? (
        <RestoreResultStep counts={restoreCounts} onDone={() => resetTo("choose")} />
      ) : null}
    </div>
  );
}

/* ---------- Step 1: choose ---------- */

function ChoosePicker({ onPick }: { onPick: (next: Step) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChooseCard
        title="Download backup"
        body="Snapshot the app DB as a JSON file. Streams instantly; no server-side state."
        icon={<Download className="h-5 w-5" aria-hidden />}
        accent="accent"
        onClick={() => onPick("backup")}
      />
      <ChooseCard
        title="Restore from backup"
        body="Upload a JSON file and merge its rows into the live DB. Existing rows untouched."
        icon={<Upload className="h-5 w-5" aria-hidden />}
        accent="warn"
        onClick={() => onPick("restore-upload")}
      />
    </div>
  );
}

function ChooseCard({
  title,
  body,
  icon,
  accent,
  onClick,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
  accent: "accent" | "warn";
  onClick: () => void;
}) {
  const accentBorder =
    accent === "accent"
      ? "border-[color:var(--color-accent)]/40 hover:border-[color:var(--color-accent)]"
      : "border-[color:var(--color-warn)]/40 hover:border-[color:var(--color-warn)]";
  const accentBg =
    accent === "accent"
      ? "bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]"
      : "bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-3 rounded-lg border-2 ${accentBorder} bg-[color:var(--color-bg-subtle)] p-5 text-left transition-colors`}
    >
      <span
        className={`inline-flex h-10 w-10 items-center justify-center rounded-md ${accentBg}`}
      >
        {icon}
      </span>
      <span className="text-base font-semibold">{title}</span>
      <span className="text-sm text-[color:var(--color-fg-muted)]">{body}</span>
    </button>
  );
}

/* ---------- Step 2A: backup ---------- */

function BackupStep({ onToast }: { onToast: (text: string) => void }) {
  return (
    <div className="space-y-5">
      <Hero icon={<Download />} title="Download backup" tone="accent">
        Click below to stream the app DB as a single JSON file. The export is audited as{" "}
        <Code>system.backup.exported</Code> with per-table row counts in the payload.
      </Hero>

      <Panel title="Included">
        <ul className="space-y-1 text-sm leading-relaxed">
          <li>
            <Pill>users</Pill> <Pill>teams</Pill> <Pill>team_members</Pill> <Pill>roles</Pill>{" "}
            <Pill>role_assignments</Pill> <Pill>zone_grants</Pill>
          </li>
          <li>
            <Pill>oidc_providers</Pill> <Pill>saml_providers</Pill> <Pill>ldap_providers</Pill>{" "}
            <Pill>auth_provider_slugs</Pill>
          </li>
          <li>
            <Pill>pdns_servers</Pill> <Pill>pdns_clusters</Pill> <Pill>backend_advisories</Pill>{" "}
            <Pill>autoprimary</Pill>
          </li>
          <li>
            <Pill>settings</Pill> <Pill>zone_templates</Pill> <Pill>api_tokens</Pill>
          </li>
          <li>Last 10,000 <Pill>audit_log</Pill> entries.</li>
        </ul>
      </Panel>

      <Panel title="Excluded" tone="warn">
        <ul className="space-y-2 text-sm leading-relaxed">
          <li>
            <strong>Zone data</strong> — PDNS owns it. Use AXFR or per-zone zonefile export for
            that.
          </li>
          <li>
            <strong>
              <Code>APP_SECRET_KEY</Code>
            </strong>{" "}
            and{" "}
            <strong>
              <Code>APP_ENCRYPTION_KEY</Code>
            </strong>{" "}
            — these stay environment-side. Encrypted columns ride through as ciphertext, useless
            without the encryption key on the restore target.
          </li>
        </ul>
      </Panel>

      <a
        href="/api/admin/backup/export"
        onClick={() => onToast("Streaming pda-backup-<date>.json…")}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[color:var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 sm:w-auto sm:px-6"
      >
        <Download className="h-4 w-4" aria-hidden /> Download backup
      </a>
    </div>
  );
}

/* ---------- Step 2B: restore-upload ---------- */

function RestoreUploadStep({
  file,
  fileInputRef,
  bundlePreview,
  restoreError,
  onPick,
  onClear,
  onNext,
}: {
  file: File | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  bundlePreview: {
    schemaVersion: number;
    appVersion: string;
    exportedAt: string;
    rowCountsByTable: Array<[string, number]>;
    totalRows: number;
  } | null;
  restoreError: string | null;
  onPick: (f: File) => void;
  onClear: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5">
      <Hero icon={<Upload />} title="Restore from backup" tone="warn">
        Upload a JSON file produced by this app's <Code>Download backup</Code>. Restore is{" "}
        <strong>merge-only</strong> — existing rows are kept; only missing rows are inserted.
      </Hero>

      <Panel title="Upload the export">
        <label className="block">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) onPick(picked);
            }}
            className="block w-full text-sm file:mr-3 file:rounded file:border file:border-[color:var(--color-border)] file:bg-[color:var(--color-bg-subtle)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[color:var(--color-fg)] hover:file:bg-[color:var(--color-bg-muted)]"
          />
        </label>
        {file ? (
          <div className="mt-3 flex items-center gap-3 text-xs text-[color:var(--color-fg-muted)]">
            <span>
              <strong className="text-[color:var(--color-fg)]">{file.name}</strong> ·{" "}
              {(file.size / 1024).toFixed(1)} KB
            </span>
            <button
              type="button"
              onClick={onClear}
              className="text-[color:var(--color-error)] hover:underline"
            >
              Remove
            </button>
          </div>
        ) : null}
      </Panel>

      {restoreError ? <ErrorBanner>{restoreError}</ErrorBanner> : null}

      {bundlePreview ? (
        <Panel title="Bundle contents">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[color:var(--color-fg-muted)]">Schema version</dt>
            <dd>
              <Code>{bundlePreview.schemaVersion}</Code>
            </dd>
            <dt className="text-[color:var(--color-fg-muted)]">Source app version</dt>
            <dd>
              <Code>{bundlePreview.appVersion}</Code>
            </dd>
            <dt className="text-[color:var(--color-fg-muted)]">Exported at</dt>
            <dd className="font-mono text-xs">{bundlePreview.exportedAt}</dd>
            <dt className="text-[color:var(--color-fg-muted)]">Total rows</dt>
            <dd>{bundlePreview.totalRows.toLocaleString()}</dd>
          </dl>
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]">
              Per-table breakdown
            </summary>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              {bundlePreview.rowCountsByTable.map(([name, n]) => (
                <li key={name} className="flex justify-between border-b border-[color:var(--color-border)]/40 py-0.5">
                  <code className="font-mono">{name}</code>
                  <span className="text-[color:var(--color-fg-muted)]">{n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </details>
        </Panel>
      ) : null}

      <button
        type="button"
        onClick={onNext}
        disabled={!bundlePreview}
        className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
      >
        Continue →
      </button>
    </div>
  );
}

/* ---------- Step 2C: restore-confirm ---------- */

function RestoreConfirmStep({
  bundlePreview,
  confirmPhrase,
  onConfirmPhraseChange,
  onRun,
  submitting,
  restoreError,
}: {
  bundlePreview: {
    rowCountsByTable: Array<[string, number]>;
    totalRows: number;
  } | null;
  confirmPhrase: string;
  onConfirmPhraseChange: (v: string) => void;
  onRun: () => void;
  submitting: boolean;
  restoreError: string | null;
}) {
  const canRun = !submitting && confirmPhrase === CONFIRM_PHRASE && bundlePreview !== null;
  return (
    <div className="space-y-5">
      <Hero icon={<AlertTriangle />} title="Confirm restore" tone="warn">
        About to merge <strong>{bundlePreview?.totalRows.toLocaleString() ?? "0"}</strong> rows
        into the live database in a single transaction. Existing rows with the same primary key
        are <em>not</em> overwritten — operators preserving prod state can restore on top safely.
      </Hero>

      <Panel title="What will happen" tone="warn">
        <ul className="space-y-1 text-sm leading-relaxed">
          <li>One DB transaction runs the merge end-to-end.</li>
          <li>
            Each row attempts an <Code>INSERT … ON CONFLICT DO NOTHING</Code>; a row that already
            exists keeps the live value.
          </li>
          <li>
            Encrypted columns require the <em>same</em> <Code>APP_ENCRYPTION_KEY</Code> as the
            source instance. Otherwise provider secrets, SP keys, and refresh tokens decrypt to
            garbage.
          </li>
          <li>
            One audit row written: <Code>system.backup.restored</Code> with per-table counts.
          </li>
        </ul>
      </Panel>

      <Panel title="Confirmation">
        <p className="mb-2 text-sm">
          Type <Code>{CONFIRM_PHRASE}</Code> to enable the run button.
        </p>
        <input
          type="text"
          value={confirmPhrase}
          onChange={(e) => onConfirmPhraseChange(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          className="block w-full max-w-xs rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-[color:var(--color-warn)] focus:outline-none"
          autoComplete="off"
        />
      </Panel>

      {restoreError ? <ErrorBanner>{restoreError}</ErrorBanner> : null}

      <button
        type="button"
        onClick={onRun}
        disabled={!canRun}
        className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-warn)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-warn-fg)] hover:opacity-95 disabled:opacity-50"
      >
        {submitting ? "Restoring…" : "Run restore"}
      </button>
    </div>
  );
}

/* ---------- Step 2D: restore-result ---------- */

function RestoreResultStep({
  counts,
  onDone,
}: {
  counts: RestoreCounts | null;
  onDone: () => void;
}) {
  const tables = counts ? Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <div className="space-y-5">
      <Hero icon={<ShieldCheck />} title="Restore complete" tone="success">
        Merge transaction committed. Per-table summary below; full detail is in the audit row
        <Code>system.backup.restored</Code>.
      </Hero>

      {tables.length === 0 ? (
        <Panel title="No rows applied">
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            The bundle had no rows in any recognised table.
          </p>
        </Panel>
      ) : (
        <Panel title="Rows by table">
          <table className="w-full text-sm">
            <thead className="text-xs text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="pb-2 text-left">Table</th>
                <th className="pb-2 text-right">Attempted</th>
                <th className="pb-2 text-right">Inserted</th>
                <th className="pb-2 text-right">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {tables.map(([name, c]) => (
                <tr key={name} className="border-t border-[color:var(--color-border)]">
                  <td className="py-1.5">
                    <code className="font-mono text-xs">{name}</code>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{c.attempted}</td>
                  <td className="py-1.5 text-right tabular-nums text-[color:var(--color-success)]">
                    {c.inserted}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[color:var(--color-fg-muted)]">
                    {c.skipped}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <button
        type="button"
        onClick={onDone}
        className="inline-flex items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-bg-muted)]"
      >
        Done
      </button>
    </div>
  );
}

/* ---------- shared visual primitives ---------- */

function Hero({
  icon,
  title,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone: "accent" | "warn" | "success";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "accent"
      ? "bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]"
      : tone === "warn"
        ? "bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]"
        : "bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]";
  const borderTone =
    tone === "accent"
      ? "border-[color:var(--color-accent)]/30"
      : tone === "warn"
        ? "border-[color:var(--color-warn)]/30"
        : "border-[color:var(--color-success)]/30";
  return (
    <div
      className={`flex gap-4 rounded-lg border ${borderTone} bg-[color:var(--color-bg-subtle)] p-5`}
    >
      <span
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${toneClass}`}
      >
        {icon}
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-[color:var(--color-fg-muted)]">{children}</p>
      </div>
    </div>
  );
}

function Panel({
  title,
  tone = "default",
  children,
}: {
  title: string;
  tone?: "default" | "warn";
  children: React.ReactNode;
}) {
  const border =
    tone === "warn"
      ? "border-[color:var(--color-warn)]/30"
      : "border-[color:var(--color-border)]";
  return (
    <section className={`rounded-lg border ${border} bg-[color:var(--color-bg)] p-5`}>
      <h3 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.8125rem]">
      {children}
    </code>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <code className="mr-1 inline-block rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[color:var(--color-fg-muted)]">
      {children}
    </code>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-3 text-sm text-[color:var(--color-error)]"
    >
      <strong className="mr-2">Error</strong>
      {children}
    </div>
  );
}

