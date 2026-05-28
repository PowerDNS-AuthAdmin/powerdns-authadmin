"use client";

/**
 * app/(app)/admin/import-export/_components/import-export-client.tsx
 *
 * Two-tab client UI:
 *
 *   - Import: pick a backend + paste a BIND zonefile (one or many
 *     zones). The server-side parser splits on $ORIGIN; we just hand
 *     it the raw text and show per-zone results.
 *   - Export: pick a backend, fetch its zone list, multi-select, and
 *     download as a single text bundle. We POST the selection (rather
 *     than GET with a query string) because zone lists can be long.
 *
 * The backend selector uses `SelectMenu` (themed). Native <select>
 * isn't allowed in this app — feedback memory.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, Download, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { apiFetch, mutate } from "@/lib/client/api-fetch";
import { SelectMenu } from "@/components/ui/select-menu";
import { useDialog } from "@/components/ui/dialog";

interface Backend {
  slug: string;
  label: string;
}

interface ImportResult {
  name: string;
  status: "created" | "failed";
  rrsetCount: number;
  error?: string;
}

interface ParseDiagnostic {
  line: number;
  level: "error" | "warning";
  message: string;
}

type Tab = "import" | "export";

const KIND_OPTIONS = [
  { value: "Master", label: "Master / Primary" },
  { value: "Native", label: "Native" },
] as const;
type ZoneKind = (typeof KIND_OPTIONS)[number]["value"];

export function ImportExportClient({
  backends,
  canImport,
}: {
  backends: Backend[];
  canImport: boolean;
}) {
  const [tab, setTab] = useState<Tab>(canImport ? "import" : "export");

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Import / Export"
        className="inline-flex rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-1"
      >
        {canImport ? (
          <TabButton active={tab === "import"} onClick={() => setTab("import")}>
            <ArrowDownToLine className="h-4 w-4" aria-hidden /> Import
          </TabButton>
        ) : null}
        <TabButton active={tab === "export"} onClick={() => setTab("export")}>
          <ArrowUpFromLine className="h-4 w-4" aria-hidden /> Export
        </TabButton>
      </div>

      {tab === "import" && canImport ? <ImportPanel backends={backends} /> : null}
      {tab === "export" ? <ExportPanel backends={backends} /> : null}
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-[color:var(--color-bg)] text-[color:var(--color-fg)] shadow-sm"
          : "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------- Import -------------------------------- */

function ImportPanel({ backends }: { backends: Backend[] }) {
  const [server, setServer] = useState<string>(backends[0]?.slug ?? "");
  const [kind, setKind] = useState<ZoneKind>("Master");
  const [zoneText, setZoneText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ParseDiagnostic[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const { toast } = useDialog();

  const handlePickFile = useCallback(async (file: File) => {
    setZoneText(await file.text());
  }, []);

  async function handleSubmit() {
    if (!server || !zoneText.trim()) return;
    setSubmitting(true);
    setResults(null);
    setDiagnostics([]);
    setTopError(null);
    try {
      const out = await mutate<{
        ok: boolean;
        error?: string;
        results: ImportResult[];
        diagnostics: ParseDiagnostic[];
      }>("/api/admin/pdns/zones/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug: server, zoneText, kind }),
      });
      if (!out.ok) {
        setTopError(out.error);
        return;
      }
      const body = out.data;
      setResults(body.results);
      setDiagnostics(body.diagnostics);
      if (!body.ok) {
        setTopError(body.error ?? "Import failed.");
        return;
      }
      const okCount = body.results.filter((r) => r.status === "created").length;
      const failCount = body.results.filter((r) => r.status === "failed").length;
      toast({
        kind: failCount === 0 ? "success" : "info",
        description: `${okCount} created${failCount > 0 ? `, ${failCount} failed` : ""}.`,
      });
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (backends.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No active PowerDNS backends configured. Add one under PowerDNS → Servers first.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <Panel>
        <h2 className="text-base font-semibold">Import a zonefile</h2>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Paste one or more zones in BIND format. Multi-zone files are split at{" "}
          <code className="rounded bg-[color:var(--color-bg-subtle)] px-1 py-0.5 text-xs">
            $ORIGIN
          </code>{" "}
          boundaries; each becomes its own zone with its records pre-populated. DNSSEC records
          (RRSIG, NSEC, …) are skipped — PowerDNS manages those.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Target backend">
            <SelectMenu
              value={server}
              onChange={setServer}
              options={backends.map((b) => ({ value: b.slug, label: b.label }))}
              ariaLabel="Target backend"
            />
          </Field>
          <Field label="Zone kind">
            <SelectMenu<ZoneKind>
              value={kind}
              onChange={setKind}
              options={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              ariaLabel="Zone kind"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Zonefile text">
            <textarea
              value={zoneText}
              onChange={(e) => setZoneText(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 font-mono text-xs text-[color:var(--color-fg)] focus:border-[color:var(--color-accent)] focus:ring-1 focus:ring-[color:var(--color-accent)] focus:outline-none"
              placeholder={`$ORIGIN example.com.\n$TTL 3600\n@   IN SOA ns1.example.com. hostmaster.example.com. (\n        2026052801 ; serial\n        3600       ; refresh\n        900        ; retry\n        1209600    ; expire\n        3600 )     ; minimum\n@   IN NS  ns1.example.com.\n@   IN NS  ns2.example.com.\nwww IN A   192.0.2.1`}
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[color:var(--color-fg-muted)]">
            <label className="inline-flex cursor-pointer items-center gap-1 underline-offset-2 hover:underline">
              <Upload className="h-3.5 w-3.5" aria-hidden />
              <span>Load from file…</span>
              <input
                type="file"
                accept=".zone,.txt,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handlePickFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <span>·</span>
            <button
              type="button"
              onClick={() => {
                setZoneText("");
                setResults(null);
                setDiagnostics([]);
                setTopError(null);
              }}
              className="underline-offset-2 hover:underline"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !server || !zoneText.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-on)] shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowDownToLine className="h-4 w-4" aria-hidden />
            {submitting ? "Importing…" : "Import"}
          </button>
        </div>

        {topError ? <ErrorBanner>{topError}</ErrorBanner> : null}
      </Panel>

      {diagnostics.length > 0 ? (
        <Panel>
          <h3 className="text-sm font-semibold">Parse diagnostics</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {diagnostics.map((d, i) => (
              <li
                key={i}
                className={
                  d.level === "error"
                    ? "text-[color:var(--color-danger)]"
                    : "text-[color:var(--color-warning)]"
                }
              >
                <span className="font-mono">L{d.line}</span> · {d.level} · {d.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {results ? (
        <Panel>
          <h3 className="text-sm font-semibold">Result</h3>
          <ul className="mt-2 divide-y divide-[color:var(--color-border)] text-sm">
            {results.map((r) => (
              <li key={r.name} className="flex items-start justify-between gap-3 py-2">
                <div>
                  <p className="font-mono">{r.name}</p>
                  {r.error ? (
                    <p className="mt-0.5 text-xs text-[color:var(--color-danger)]">{r.error}</p>
                  ) : null}
                </div>
                <span
                  className={
                    r.status === "created"
                      ? "rounded-full bg-[color:var(--color-success-bg)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-success-fg)]"
                      : "rounded-full bg-[color:var(--color-danger-bg)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-danger-fg)]"
                  }
                >
                  {r.status} · {r.rrsetCount} rrsets
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/* -------------------------------- Export -------------------------------- */

interface ZoneSummary {
  id: string;
  name: string;
  kind: string;
}

function ExportPanel({ backends }: { backends: Backend[] }) {
  const [server, setServer] = useState<string>(backends[0]?.slug ?? "");
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Load zones whenever the backend changes.
  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    mutate<{ zones: ZoneSummary[] }>(
      `/api/admin/pdns/zones/list?serverSlug=${encodeURIComponent(server)}`,
    )
      .then((out) => {
        if (cancelled) return;
        if (!out.ok) {
          setError(out.error);
          setZones([]);
          return;
        }
        setZones(out.data.zones);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load zones.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server]);

  const filtered = useMemo<ZoneSummary[]>(() => {
    if (!zones) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => z.name.toLowerCase().includes(q));
  }, [zones, filter]);

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const z of filtered) next.add(z.name);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleDownload() {
    if (selected.size === 0) return;
    setDownloading(true);
    setError(null);
    try {
      // Raw apiFetch (not mutate) so we can read the response as a blob —
      // mutate assumes JSON. apiFetch attaches CSRF automatically.
      const res = await apiFetch("/api/admin/pdns/zones/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug: server, zones: [...selected] }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body !== "" ? body : `Export failed (${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      a.download = m?.[1] ?? `zones-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setDownloading(false);
    }
  }

  if (backends.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No active PowerDNS backends configured.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <Panel>
        <h2 className="text-base font-semibold">Export zones</h2>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Pick a backend, choose the zones you want, and download them as a single text bundle (one
          file, BIND format). One audit row is written per zone read.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Source backend">
            <SelectMenu
              value={server}
              onChange={setServer}
              options={backends.map((b) => ({ value: b.slug, label: b.label }))}
              ariaLabel="Source backend"
            />
          </Field>
          <Field label="Filter">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="zone name contains…"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm text-[color:var(--color-fg)] focus:border-[color:var(--color-accent)] focus:ring-1 focus:ring-[color:var(--color-accent)] focus:outline-none"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            {loading
              ? "Loading…"
              : zones === null
                ? ""
                : `${selected.size} selected · ${filtered.length} shown · ${zones.length} total`}
          </p>
          <div className="flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={selectAllFiltered}
              disabled={filtered.length === 0}
              className="underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Select all shown
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={selected.size === 0}
              className="underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 max-h-96 overflow-y-auto rounded-md border border-[color:var(--color-border)]">
          {filtered.length === 0 ? (
            <p className="p-4 text-center text-sm text-[color:var(--color-fg-muted)]">
              {loading ? "Loading zones…" : "No zones match."}
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {filtered.map((z) => {
                const checked = selected.has(z.name);
                return (
                  <li key={z.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]">
                      <Checkbox checked={checked} onChange={() => toggle(z.name)} />
                      <span className="flex-1 font-mono">{z.name}</span>
                      <span className="text-xs text-[color:var(--color-fg-muted)]">{z.kind}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading || selected.size === 0}
            className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-on)] shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" aria-hidden />
            {downloading
              ? "Preparing…"
              : `Download ${selected.size > 0 ? `(${selected.size})` : ""}`}
          </button>
        </div>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      </Panel>
    </div>
  );
}

/* -------------------------------- primitives -------------------------------- */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5 shadow-sm">
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-md border border-[color:var(--color-danger-border)] bg-[color:var(--color-danger-bg)] p-3 text-sm text-[color:var(--color-danger-fg)]">
      {children}
    </div>
  );
}

/**
 * Themed checkbox — the user has banned default <input type="checkbox">
 * (feedback-themed-form-controls). This is a styled box that mirrors
 * the rest of the app.
 */
function Checkbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        onChange();
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange();
        }
      }}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
        checked
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-accent-on)]"
          : "border-[color:var(--color-border)] bg-[color:var(--color-bg)]"
      }`}
    >
      {checked ? (
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
          <path
            d="M3 8.5l3 3 7-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}
