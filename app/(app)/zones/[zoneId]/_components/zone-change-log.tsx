"use client";

/**
 * app/(app)/zones/[zoneId]/_components/zone-change-log.tsx
 *
 * Per-zone change history. Table-shaped feed of audit events with filters
 * (search, action, actor, date range), pagination, and per-row click-to-
 * expand revealing the side-by-side Before / After diff. The diff itself
 * is rendered by `BareDiff`; the wrapper is intentionally chrome-light so
 * dense activity scans well.
 *
 * Audit row → diff input mapping:
 *   - record.create:        before=[]              after=[after-rrset]
 *   - record.update:        before=[before]        after=[after]
 *   - record.delete:        before=[before]        after=[]
 *   - SOA changes:          same as update
 *   - zone.metadata.set:    each value as a line   keyed by KIND
 *   - zone.metadata.delete: before only
 *   - zone.settings.update: field-by-field
 *   - dnssec.cryptokey.*:   field-by-field
 *
 * Non-diffable events (zone.notify) render a one-line summary on expand.
 */

import { useEffect, useMemo, useState } from "react";
import { colorForAuditAction } from "@/lib/audit/action-color";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { SelectMenu } from "@/components/ui/select-menu";
import { BareDiff } from "./bare-diff";
import { PdnsHttpLog, type PdnsHttpLogEntry } from "./pdns-http-log";

interface RRsetSnapshot {
  name: string;
  type: string;
  ttl?: number;
  records: Array<{ content: string; disabled?: boolean }>;
  /**
   * PDNS attaches comments at the rrset level. The audit writer
   * snapshots them as `{ content, account, modified_at }[]`. We pull
   * the `content` fields out so a comment-only edit still produces a
   * visible diff line below the record lines.
   */
  comments?: Array<{ content?: string }>;
}

export interface ZoneAuditEntryClient {
  id: string;
  ts: string;
  actorType: "user" | "token" | "system";
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  /**
   * Per-operation correlation id (every audit row from the same HTTP
   * request shares this). Each change-log row deep-links to the audit
   * log filtered on `requestId` so the operator can see all side-effects
   * of one operation — a `record.update` and its sibling `zone.notify`,
   * for instance.
   */
  requestId: string | null;
}

interface ZoneChangeLogProps {
  entries: ZoneAuditEntryClient[];
  /**
   * Map from operation correlation id → raw PDNS HTTP requests issued
   * during that operation. Rendered inline as a collapsible per row.
   * Empty map (or missing key) hides the section.
   */
  pdnsHttpByRequestId?: Map<string, PdnsHttpLogEntry[]>;
  zoneName: string;
}

const PAGE_SIZES = [10, 25, 50, 100] as const;

export function ZoneChangeLog({ entries, zoneName, pdnsHttpByRequestId }: ZoneChangeLogProps) {
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Distinct action / actor values for the filter dropdowns.
  const actionChoices = useMemo(
    () => Array.from(new Set(entries.map((e) => e.action))).sort(),
    [entries],
  );
  const actorChoices = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.actorEmail ?? (e.actorType === "system" ? "system" : "—"));
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fromTs = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
    const toTs = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
    return entries.filter((e) => {
      if (actionFilter && e.action !== actionFilter) return false;
      const actor = e.actorEmail ?? (e.actorType === "system" ? "system" : "—");
      if (actorFilter && actor !== actorFilter) return false;
      const ts = new Date(e.ts).getTime();
      if (ts < fromTs || ts > toTs) return false;
      if (q) {
        const hay = [e.action, actor, e.actorName ?? "", e.resourceType, e.resourceId ?? ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, query, actionFilter, actorFilter, from, to]);

  // Reset to first page when filters change.
  useEffect(() => {
    setPage(0);
  }, [query, actionFilter, actorFilter, from, to, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const shown = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setActionFilter("");
    setActorFilter("");
    setFrom("");
    setTo("");
  }

  const anyFilter =
    query !== "" || actionFilter !== "" || actorFilter !== "" || from !== "" || to !== "";

  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
        No recorded changes for this zone yet. As operators add, edit, or delete records, the diff
        for each change will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Filters
        query={query}
        onQuery={setQuery}
        actionFilter={actionFilter}
        onActionFilter={setActionFilter}
        actionChoices={actionChoices}
        actorFilter={actorFilter}
        onActorFilter={setActorFilter}
        actorChoices={actorChoices}
        from={from}
        onFrom={setFrom}
        to={to}
        onTo={setTo}
        anyFilter={anyFilter}
        onClear={clearFilters}
      />

      <p className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
        {filtered.length === entries.length
          ? `${entries.length} change${entries.length === 1 ? "" : "s"}`
          : `${filtered.length} of ${entries.length} change${entries.length === 1 ? "" : "s"} match`}{" "}
        for <code className="font-mono">{zoneName}</code>.
      </p>

      {filtered.length === 0 ? (
        <p className="rounded border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4 text-center text-xs text-[color:var(--color-fg-muted)]">
          No events match the current filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="w-8 py-2 pr-2 pl-3"></th>
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                <th className="py-2 pr-3 font-medium">Resource</th>
                <th className="py-2 pr-3 font-medium">Actor</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <ChangeRow
                  key={entry.id}
                  entry={entry}
                  zoneName={zoneName}
                  expanded={expanded.has(entry.id)}
                  onToggle={() => toggleRow(entry.id)}
                  httpLog={httpEntriesForAuditAction(
                    entry.action,
                    entry.requestId ? (pdnsHttpByRequestId?.get(entry.requestId) ?? []) : [],
                  )}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 ? (
        <Pagination
          page={safePage}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSize={setPageSize}
        />
      ) : null}
    </div>
  );
}

function ChangeRow({
  entry,
  zoneName,
  expanded,
  onToggle,
  httpLog,
}: {
  entry: ZoneAuditEntryClient;
  zoneName: string;
  expanded: boolean;
  onToggle: () => void;
  httpLog: PdnsHttpLogEntry[];
}) {
  const { removed, added } = useMemo(() => computeEntryDiff(entry), [entry]);
  const resourceLabel = describeResource(entry, zoneName);
  const diffable = isDiffableAction(entry.action);
  const actor = entry.actorEmail ?? (entry.actorType === "system" ? "system" : "—");

  return (
    <>
      <tr
        className="cursor-pointer border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="py-2 pr-2 pl-3 text-[color:var(--color-fg-muted)]">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path
              d="M3 2l4 3-4 3"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </td>
        <td className="py-2 pr-3 font-mono whitespace-nowrap text-[color:var(--color-fg-muted)]">
          {formatTimestamp(entry.ts)}
        </td>
        <td className="py-2 pr-3">
          <ActionChip action={entry.action} />
        </td>
        <td className="py-2 pr-3 font-mono text-[color:var(--color-fg)]">{resourceLabel ?? "—"}</td>
        <td className="py-2 pr-3 text-[color:var(--color-fg-muted)]">
          {actor}
          {entry.actorName ? (
            <span className="ml-1 text-[color:var(--color-fg-subtle)]">({entry.actorName})</span>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t border-[color:var(--color-border)]">
          <td colSpan={5} className="bg-[color:var(--color-bg)] p-0">
            {entry.requestId ? (
              <div className="flex justify-end border-b border-[color:var(--color-border)] px-4 py-2 text-[0.6875rem]">
                <a
                  href={`/admin/audit?${new URLSearchParams({ requestId: entry.requestId }).toString()}`}
                  className="text-[color:var(--color-accent)] hover:underline"
                  title="See every audit row from this operation — record edit, notify, etc."
                >
                  View operation in audit log →
                </a>
              </div>
            ) : null}
            {diffable ? (
              removed.length === 0 && added.length === 0 ? (
                <p className="px-4 py-3 text-xs text-[color:var(--color-fg-muted)]">
                  Audit row carries no diffable snapshot.
                </p>
              ) : (
                <BareDiff removed={removed} added={added} />
              )
            ) : (
              <div className="px-4 py-3">
                <ZoneEventLine entry={entry} />
              </div>
            )}
            {httpLog.length > 0 ? <PdnsHttpLog entries={httpLog} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

interface FiltersProps {
  query: string;
  onQuery: (v: string) => void;
  actionFilter: string;
  onActionFilter: (v: string) => void;
  actionChoices: readonly string[];
  actorFilter: string;
  onActorFilter: (v: string) => void;
  actorChoices: readonly string[];
  from: string;
  onFrom: (v: string) => void;
  to: string;
  onTo: (v: string) => void;
  anyFilter: boolean;
  onClear: () => void;
}

function Filters({
  query,
  onQuery,
  actionFilter,
  onActionFilter,
  actionChoices,
  actorFilter,
  onActorFilter,
  actorChoices,
  from,
  onFrom,
  to,
  onTo,
  anyFilter,
  onClear,
}: FiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-2 text-[0.6875rem]">
      <FilterField label="Search">
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="action, actor, resource…"
          className="block w-56 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs outline-none"
        />
      </FilterField>
      <FilterField label="Action">
        <SelectMenu
          value={actionFilter}
          onChange={onActionFilter}
          placeholder="all"
          ariaLabel="Action"
          className="w-44 text-xs"
          options={actionChoices.map((a) => ({ value: a, label: a }))}
        />
      </FilterField>
      <FilterField label="Actor">
        <SelectMenu
          value={actorFilter}
          onChange={onActorFilter}
          placeholder="all"
          ariaLabel="Actor"
          className="w-44 text-xs"
          options={actorChoices.map((a) => ({ value: a, label: a }))}
        />
      </FilterField>
      <FilterField label="From">
        <DateTimePicker
          value={from}
          onChange={onFrom}
          side="from"
          className="block rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
        />
      </FilterField>
      <FilterField label="To">
        <DateTimePicker
          value={to}
          onChange={onTo}
          side="to"
          className="block rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
        />
      </FilterField>
      {anyFilter ? (
        <button
          type="button"
          onClick={onClear}
          className="ml-1 self-end rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSize: (size: (typeof PAGE_SIZES)[number]) => void;
}

function Pagination({ page, totalPages, pageSize, onPageChange, onPageSize }: PaginationProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[0.6875rem]">
      <div className="flex items-center gap-2">
        <span className="text-[color:var(--color-fg-muted)]">Rows per page</span>
        <SelectMenu
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v) as (typeof PAGE_SIZES)[number])}
          ariaLabel="Rows per page"
          className="w-20 text-xs"
          options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[color:var(--color-fg-muted)]">
          Page {page + 1} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * Action types whose payloads we render as a two-column `-` / `+` diff via
 * BareDiff. Each handled in `computeEntryDiff` — the snapshot shape varies
 * per resource type but the output is always two `string[]`s of line-shaped
 * facts.
 */
function isDiffableAction(action: string): boolean {
  return (
    action.startsWith("record.") ||
    action.startsWith("zone.metadata.") ||
    action === "zone.settings.update" ||
    action.startsWith("dnssec.cryptokey.")
  );
}

/**
 * Convert an audit entry's before/after snapshot into the line-shaped
 * pair BareDiff renders. The shape depends on the action:
 *   record.*            — BIND-style `name TTL IN TYPE content` per record
 *   zone.metadata.*     — `<KIND> = <value>` per stored value
 *   zone.settings.update — `<field> = <value>` per zone-object field
 *   dnssec.cryptokey.*  — `<field> = <value>` per key field
 */
function computeEntryDiff(entry: ZoneAuditEntryClient): { removed: string[]; added: string[] } {
  if (entry.resourceType === "rrset") {
    return computeRecordDiff(
      entry.before as RRsetSnapshot | null,
      entry.after as RRsetSnapshot | null,
    );
  }
  if (entry.action.startsWith("zone.metadata.")) {
    return computeMetadataDiff(entry);
  }
  if (entry.action === "zone.settings.update") {
    return computeSettingsDiff(entry);
  }
  if (entry.action.startsWith("dnssec.cryptokey.")) {
    return computeCryptokeyDiff(entry);
  }
  return { removed: [], added: [] };
}

/**
 * Symmetric difference of two RRset snapshots, record-by-record. Each
 * record becomes one BIND-style line; lines present in `before` and not
 * in `after` are "removed", lines present in `after` and not in `before`
 * are "added". Deduped (sorted) so the diff reads consistently.
 */
function computeRecordDiff(
  before: RRsetSnapshot | null,
  after: RRsetSnapshot | null,
): { removed: string[]; added: string[] } {
  const beforeLines = snapshotToLines(before);
  const afterLines = snapshotToLines(after);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((l) => !afterSet.has(l)).sort();
  const added = afterLines.filter((l) => !beforeSet.has(l)).sort();
  return { removed, added };
}

/**
 * Render an rrset snapshot as one BIND-style line per record, plus a
 * single synthetic `; <name> <TYPE> comment: <text>` line when the
 * rrset carries a non-empty comment. The comment line is keyed by name
 * + type so a comment-only edit pairs across before/after instead of
 * collapsing into "no diffable snapshot".
 */
function snapshotToLines(snapshot: RRsetSnapshot | null): string[] {
  if (!snapshot || !Array.isArray(snapshot.records)) return [];
  const recordLines = snapshot.records.map((r) => {
    const prefix = r.disabled ? "; DISABLED " : "";
    const ttl = snapshot.ttl ?? 0;
    return `${prefix}${snapshot.name}\t${ttl}\tIN\t${snapshot.type}\t${r.content}`;
  });
  const commentText = Array.isArray(snapshot.comments)
    ? snapshot.comments
        .map((c) => (typeof c?.content === "string" ? c.content : ""))
        .filter((s) => s.length > 0)
        .join(" · ")
    : "";
  if (commentText !== "") {
    recordLines.push(`; ${snapshot.name} ${snapshot.type} comment: ${commentText}`);
  }
  return recordLines;
}

/**
 * Narrow an `unknown` audit snapshot (a JSON column) to a typed shape.
 * Using a generic keeps `no-unnecessary-type-assertion` from mis-flagging
 * the cast: `unknown ?? null` collapses to `{} | null`, which the rule
 * considers mutually-assignable to an all-optional interface and would
 * strip — breaking the downstream typed access.
 */
function snapshotOf<T>(value: unknown): T | null {
  return (value ?? null) as T | null;
}

interface MetadataSnapshot {
  kind?: string;
  values?: string[];
}

function computeMetadataDiff(entry: ZoneAuditEntryClient): {
  removed: string[];
  added: string[];
} {
  const before = snapshotOf<MetadataSnapshot>(entry.before);
  const after = snapshotOf<MetadataSnapshot>(entry.after);
  const kind = after?.kind ?? before?.kind ?? "(unknown)";
  return diffLineSets(
    metadataValueLines(kind, before?.values),
    metadataValueLines(kind, after?.values),
  );
}

function metadataValueLines(kind: string, values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values.map((v) => `${kind}\t${v}`);
}

interface SettingsSnapshot {
  kind?: string;
  masters?: readonly string[];
  soa_edit?: string;
  soa_edit_api?: string;
  api_rectify?: boolean;
}

function computeSettingsDiff(entry: ZoneAuditEntryClient): { removed: string[]; added: string[] } {
  const before = snapshotOf<SettingsSnapshot>(entry.before);
  const after = snapshotOf<SettingsSnapshot>(entry.after);
  return diffFieldChanges(settingsToFieldLines(before), settingsToFieldLines(after));
}

function settingsToFieldLines(s: SettingsSnapshot | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!s) return out;
  if (s.kind !== undefined) out.set("kind", String(s.kind));
  if (s.masters !== undefined) out.set("masters", s.masters.join(", "));
  if (s.soa_edit !== undefined) out.set("soa_edit", s.soa_edit || "(unset)");
  if (s.soa_edit_api !== undefined) out.set("soa_edit_api", s.soa_edit_api || "(unset)");
  if (s.api_rectify !== undefined) out.set("api_rectify", String(s.api_rectify));
  return out;
}

interface CryptokeySnapshot {
  cryptokeyId?: number;
  keytype?: string;
  active?: boolean;
  published?: boolean;
  algorithm?: string;
  bits?: number;
}

function computeCryptokeyDiff(entry: ZoneAuditEntryClient): {
  removed: string[];
  added: string[];
} {
  const before = snapshotOf<CryptokeySnapshot>(entry.before);
  const after = snapshotOf<CryptokeySnapshot>(entry.after);
  return diffFieldChanges(cryptokeyToFieldLines(before), cryptokeyToFieldLines(after));
}

function cryptokeyToFieldLines(k: CryptokeySnapshot | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!k) return out;
  if (k.cryptokeyId !== undefined) out.set("id", String(k.cryptokeyId));
  if (k.keytype !== undefined) out.set("keytype", k.keytype);
  if (k.algorithm !== undefined) out.set("algorithm", k.algorithm);
  if (k.bits !== undefined) out.set("bits", String(k.bits));
  if (k.active !== undefined) out.set("active", String(k.active));
  if (k.published !== undefined) out.set("published", String(k.published));
  return out;
}

/**
 * Field-by-field diff for "object of scalar fields" snapshots (settings,
 * cryptokeys). A field that changed value produces both a removed and an
 * added line. A field that only existed on one side produces a one-sided
 * line. Identical fields produce no output.
 */
function diffFieldChanges(
  before: Map<string, string>,
  after: Map<string, string>,
): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === a) continue;
    if (b !== undefined) removed.push(`${key} = ${b}`);
    if (a !== undefined) added.push(`${key} = ${a}`);
  }
  return { removed, added };
}

/** Symmetric set difference on two line arrays (sorted, deduped). */
function diffLineSets(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): { removed: string[]; added: string[] } {
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((l) => !afterSet.has(l)).sort();
  const added = afterLines.filter((l) => !beforeSet.has(l)).sort();
  return { removed, added };
}

function ZoneEventLine({ entry }: { entry: ZoneAuditEntryClient }) {
  if (entry.action === "zone.notify" && entry.after && typeof entry.after === "object") {
    const a = entry.after as {
      success?: boolean;
      error?: string | null;
      kind?: string;
    };
    return (
      <p className="text-xs">
        {a.success ? (
          <span className="text-[color:var(--color-success)]">
            NOTIFY sent ({a.kind ?? "zone"}).
          </span>
        ) : (
          <span className="text-[color:var(--color-error)]">
            NOTIFY failed{a.error ? `: ${a.error}` : ""}.
          </span>
        )}
      </p>
    );
  }

  if (entry.action.startsWith("dnssec.cryptokey.")) {
    return <CryptokeyEventLine entry={entry} />;
  }

  if (entry.action.startsWith("zone.metadata.")) {
    return <MetadataEventLine entry={entry} />;
  }

  return (
    <p className="text-xs text-[color:var(--color-fg-muted)]">
      Zone-level event with no diffable payload.
    </p>
  );
}

function CryptokeyEventLine({ entry }: { entry: ZoneAuditEntryClient }) {
  const before = snapshotOf<{
    cryptokeyId?: number;
    keytype?: string;
    active?: boolean;
    published?: boolean;
  }>(entry.before);
  const after = snapshotOf<{
    cryptokeyId?: number;
    keytype?: string;
    active?: boolean;
    algorithm?: string;
    bits?: number;
    published?: boolean;
  }>(entry.after);
  const id = after?.cryptokeyId ?? before?.cryptokeyId;
  const idLabel = id !== undefined ? `id ${id}` : "(no id)";

  if (entry.action === "dnssec.cryptokey.create" && after) {
    const algo = after.algorithm ? ` ${after.algorithm}` : "";
    const bits = after.bits ? ` ${after.bits}-bit` : "";
    return (
      <p className="text-xs">
        Created DNSSEC key {idLabel}: <code>{after.keytype ?? "?"}</code>
        {algo}
        {bits}
        {after.active === false ? (
          <span className="ml-1 text-[color:var(--color-fg-muted)]">(inactive)</span>
        ) : null}
      </p>
    );
  }

  if (entry.action === "dnssec.cryptokey.update" && before && after) {
    const changes: string[] = [];
    if (before.active !== after.active) {
      changes.push(`active ${String(before.active)} → ${String(after.active)}`);
    }
    if (before.published !== after.published) {
      changes.push(`published ${String(before.published)} → ${String(after.published)}`);
    }
    return (
      <p className="text-xs">
        Updated DNSSEC key {idLabel}:{" "}
        {changes.length > 0 ? changes.join(", ") : "no observable changes"}.
      </p>
    );
  }

  if (entry.action === "dnssec.cryptokey.delete" && before) {
    const kt = before.keytype ?? "?";
    const wasActive = before.active === true ? "active" : "inactive";
    return (
      <p className="text-xs">
        Deleted DNSSEC key {idLabel}: was <code>{kt}</code> ({wasActive}).
      </p>
    );
  }

  return (
    <p className="text-xs text-[color:var(--color-fg-muted)]">
      DNSSEC key event (incomplete snapshot).
    </p>
  );
}

function MetadataEventLine({ entry }: { entry: ZoneAuditEntryClient }) {
  const before = snapshotOf<{ kind?: string; values?: string[] }>(entry.before);
  const after = snapshotOf<{ kind?: string; values?: string[] }>(entry.after);
  const kind = after?.kind ?? before?.kind ?? "(unknown)";

  if (entry.action === "zone.metadata.set") {
    const values = after?.values ?? [];
    const display = values.length === 0 ? "(empty)" : values.join(", ");
    const beforeValues = before?.values;
    return (
      <p className="text-xs">
        Set metadata <code>{kind}</code> to <code className="break-all">{display}</code>
        {beforeValues && beforeValues.length > 0 ? (
          <span className="text-[color:var(--color-fg-muted)]">
            {" "}
            (was <code className="break-all">{beforeValues.join(", ")}</code>)
          </span>
        ) : null}
        .
      </p>
    );
  }

  if (entry.action === "zone.metadata.delete") {
    return (
      <p className="text-xs">
        Deleted metadata <code>{kind}</code>
        {before?.values && before.values.length > 0 ? (
          <span className="text-[color:var(--color-fg-muted)]">
            {" "}
            (was <code className="break-all">{before.values.join(", ")}</code>)
          </span>
        ) : null}
        .
      </p>
    );
  }

  return <p className="text-xs text-[color:var(--color-fg-muted)]">Metadata event.</p>;
}

function ActionChip({ action }: { action: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[0.65rem] tracking-wide uppercase ${colorForAuditAction(action)}`}
    >
      {action}
    </span>
  );
}

function describeResource(entry: ZoneAuditEntryClient, zoneName: string): string | null {
  if (entry.resourceType === "rrset" && entry.resourceId) {
    const trailing = entry.resourceId.split(":").slice(2).join(":");
    const [rrName, rrType] = trailing.split("|");
    const display = displayName(rrName ?? "", zoneName) || "@";
    return `${display} ${rrType ?? ""}`.trim();
  }

  // Zone-scoped events. Header chip gets a useful identifier so the
  // operator can scan the feed without expanding each row.
  if (entry.action.startsWith("dnssec.cryptokey.")) {
    const id = readCryptokeyId(entry.before) ?? readCryptokeyId(entry.after);
    return id !== null ? `DNSSEC key id ${id}` : "DNSSEC key";
  }

  if (entry.action.startsWith("zone.metadata.")) {
    const kind = readMetadataKind(entry.after) ?? readMetadataKind(entry.before);
    return kind ? `metadata ${kind}` : "metadata";
  }

  if (entry.action === "zone.settings.update") return "zone settings";

  if (entry.action === "zone.notify") return "NOTIFY";

  return null;
}

function readCryptokeyId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)["cryptokeyId"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readMetadataKind(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)["kind"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function displayName(name: string, zoneName: string): string {
  if (name === zoneName) return "";
  if (name.endsWith(`.${zoneName}`)) {
    return name.slice(0, name.length - zoneName.length - 1);
  }
  return name;
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Split the per-operation PDNS HTTP requests between the audit rows
 * they belong to. A `record.update` PATCH that triggers a NOTIFY
 * produces TWO audit rows (`record.update` + `zone.notify`) that share
 * one `requestId`; without filtering, both rows would show the same
 * three HTTP calls. We bucket the calls by op so each audit row only
 * surfaces the HTTP traffic it actually authored.
 */
function httpEntriesForAuditAction(
  action: string,
  entries: PdnsHttpLogEntry[],
): PdnsHttpLogEntry[] {
  if (entries.length === 0) return entries;
  if (action === "zone.notify") {
    return entries.filter((e) => /notify/i.test(e.op));
  }
  if (action.startsWith("zone.metadata.")) {
    return entries.filter((e) => /metadata/i.test(e.op));
  }
  if (action.startsWith("dnssec.cryptokey.")) {
    return entries.filter((e) => /cryptokey/i.test(e.op));
  }
  if (action === "zone.settings.update") {
    // The zone-settings PUT is a single `zones.settings.update` op; the
    // page also re-fetches the zone before+after for the snapshot.
    return entries.filter((e) => !/notify/i.test(e.op));
  }
  if (action.startsWith("record.") || action === "zone.create" || action === "zone.delete") {
    // Mutation rows own the get/patch/create traffic; the sibling
    // zone.notify row owns the notify call.
    return entries.filter((e) => !/notify/i.test(e.op));
  }
  // Default: show everything for unknown actions.
  return entries;
}
