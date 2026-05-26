"use client";

/**
 * app/(app)/zones/[zoneId]/_components/editable-record-table.tsx
 *
 * Interactive zone editor. Each (name, type, value) is its own row — a
 * single `www A` RRset with three IPs renders as three rows, edited /
 * deleted independently. On save the editor groups rows back into RRsets
 * (PDNS's atomic unit) and emits one REPLACE per (name, type).
 *
 * SOA is intentionally absent: it's edited through `<SoaPanel>` above the
 * records table, and filtered out of every view here (table, type dropdown,
 * BIND diff).
 *
 * Validation: each record's content runs through the per-RR-type validator
 * in `lib/validators/rr-types/`. Errors block save by default; the operator
 * can tick "Save anyway" to override (RFC-borderline content with a known-
 * good intent gets through). Warnings never block — they just inform.
 */

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { Dialog, useDialog } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { createCtaClass } from "@/components/ui/create-button";
import { SelectMenu } from "@/components/ui/select-menu";
import { mutate } from "@/lib/client/api-fetch";
import {
  defaultTypeForZone,
  getRRTypeValidator,
  hasErrors,
  typesForZone,
  type RRValidationResult,
} from "@/lib/validators/rr-types";
import { BareDiff, computeBindDiff } from "./bare-diff";
import { NumberInput } from "./number-input";
import { RRContentField } from "@/components/domain/rr-editors";

interface RecordValue {
  content: string;
  disabled?: boolean;
}

interface RRsetView {
  name: string;
  type: string;
  ttl: number;
  records: RecordValue[];
  /** Rrset-level comment (PDNS attaches comments to the rrset, not per-record). */
  comment: string;
}

/** Flattened single-value row — what the table renders. */
interface RecordRow {
  name: string;
  type: string;
  ttl: number;
  value: string;
  disabled: boolean;
  /** Index of this value inside its RRset (stable per current data). */
  recordIdx: number;
  /** Mirror of the rrset's comment; every row of the same rrset shares it. */
  comment: string;
}

interface EditableRecordTableProps {
  zoneName: string;
  rrsets: RRsetView[];
  serverSlug: string;
  zoneIdEncoded: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

interface EditorState {
  mode: "create" | "edit";
  /** For edit: the row being edited (so we know which value within the RRset). */
  originalRow?: RecordRow;
  name: string;
  type: string;
  ttl: number;
  value: string;
  /**
   * Stash of content the operator has had open per RR-type during this
   * editor session. When the type select switches, the *current* type's
   * value is parked here and the new type's value is restored (or "" if
   * we've never visited it). Lets you flip MX → TXT → MX without losing
   * what the MX field had.
   *
   * Indexed by the uppercase RR-type slug (`SUPPORTED_TYPES` entries).
   */
  valuesByType: Record<string, string>;
  disabled: boolean;
  comment: string;
  /**
   * Validation visibility gate — see the inline comment near the value input
   * below. False while the user is mid-keystroke on a fresh field; flips
   * true on first blur and stays true thereafter. Edit mode starts true
   * because the row arrives with content the user can already act on.
   */
  valueTouched: boolean;
}

interface PendingPatch {
  /** All RRset-level changes the patch will apply. Visualized in the diff. */
  rrsetsAfter: RRsetView[];
  /** Per-(name,type) delete/upsert payload sent to the API. */
  changes: PatchChange[];
  /** Plain-English description for the toast on success. */
  summary: string;
}

interface PatchChange {
  kind: "upsert" | "delete";
  name: string;
  type: string;
  ttl?: number;
  records?: RecordValue[];
  /**
   * When defined, the route uses this exact comment string (empty
   * string clears the rrset's comments). When undefined, the route
   * preserves whatever PDNS already has — important for record edits
   * that don't touch the comment.
   */
  comment?: string;
}

const DEFAULT_TTL = 3600;

export function EditableRecordTable(props: EditableRecordTableProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();

  // SOA never appears in the records UI — it's owned by <SoaPanel>.
  const nonSoa = useMemo(() => props.rrsets.filter((rr) => rr.type !== "SOA"), [props.rrsets]);

  // Mirror the latest snapshot into a ref so closures inside the
  // memoized columns (which don't include `nonSoa` in their deps —
  // re-memoizing on every prop change would thrash TanStack's
  // internal table instance) can still read the freshest data.
  // Without this ref, the Delete button's cached closure would call
  // buildDeleteChange against a STALE nonSoa, missing records that
  // were created earlier in the same page lifecycle — that's the
  // "delete a freshly-created record silently no-ops" bug.
  const nonSoaRef = useRef(nonSoa);
  nonSoaRef.current = nonSoa;

  const rows = useMemo(() => flattenRrsetsToRows(nonSoa, props.zoneName), [nonSoa, props.zoneName]);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [overrideErrors, setOverrideErrors] = useState(false);
  const [pending, setPending] = useState<PendingPatch | null>(null);
  const [saving, setSaving] = useState(false);

  const showActions = props.canUpdate || props.canDelete;

  const columns = useMemo<Array<ColumnDef<RecordRow, unknown>>>(() => {
    const base: Array<ColumnDef<RecordRow, unknown>> = [
      {
        id: "name",
        accessorFn: (row) => displayName(row.name, props.zoneName) || "@",
        header: "Name",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
        meta: { className: "w-[22%]" },
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: (ctx) => <span className="text-xs font-medium">{ctx.getValue<string>()}</span>,
        meta: { className: "w-[8%]" },
      },
      {
        accessorKey: "ttl",
        header: "TTL",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<number>()}</span>,
        meta: { className: "w-[8%]" },
      },
      {
        id: "value",
        accessorFn: (row) => row.value,
        header: "Value",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <span
              className={`block font-mono text-xs break-all ${row.disabled ? "text-[color:var(--color-fg-subtle)] line-through" : ""}`}
            >
              {row.value}
              {row.disabled ? (
                <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1 py-0.5 text-[0.65rem] tracking-wide uppercase no-underline">
                  disabled
                </span>
              ) : null}
            </span>
          );
        },
        meta: { className: "w-[30%]" },
      },
      {
        id: "comment",
        accessorFn: (row) => row.comment,
        header: "Comment",
        enableSorting: false,
        cell: (ctx) => {
          const text = ctx.row.original.comment;
          return text ? (
            <span className="text-xs text-[color:var(--color-fg-muted)] italic">{text}</span>
          ) : (
            <span className="text-xs text-[color:var(--color-fg-subtle)]">—</span>
          );
        },
        meta: { className: "w-[18%]" },
      },
    ];

    if (showActions) {
      base.push({
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "w-[14%] text-right" },
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <span className="text-xs">
              {props.canUpdate ? (
                <button
                  type="button"
                  onClick={() => openEdit(row)}
                  className="text-[color:var(--color-accent)] hover:underline"
                >
                  Edit
                </button>
              ) : null}
              {props.canUpdate && props.canDelete ? (
                <span className="px-2 text-[color:var(--color-fg-subtle)]">·</span>
              ) : null}
              {props.canDelete ? (
                <button
                  type="button"
                  onClick={() => handleDeleteRow(row)}
                  className="text-[color:var(--color-error)] hover:underline"
                >
                  Delete
                </button>
              ) : null}
            </span>
          );
        },
      });
    }
    return base;
    // openEdit/handleDeleteRow are intentionally omitted: both are stale-safe
    // by construction (functional setState + handleDeleteRow reads the live
    // `nonSoaRef.current`, see below), so rebuilding the column defs when they
    // change would be churn without correctness benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.canUpdate, props.canDelete, props.zoneName, showActions]);

  // ===== Editor handlers =====================================================

  function openCreate() {
    setEditorError(null);
    setOverrideErrors(false);
    setEditor({
      mode: "create",
      name: "",
      // Reverse zones default to PTR; forward zones default to A. Saves the
      // operator the extra dropdown click on the common case for that zone.
      type: defaultTypeForZone(props.zoneName),
      ttl: DEFAULT_TTL,
      value: "",
      valuesByType: {},
      disabled: false,
      comment: "",
      valueTouched: false,
    });
  }

  function openEdit(row: RecordRow) {
    setEditorError(null);
    setOverrideErrors(false);
    setEditor({
      mode: "edit",
      originalRow: row,
      name: displayName(row.name, props.zoneName),
      type: row.type,
      ttl: row.ttl,
      value: row.value,
      // Seed with the original type's value so switching away and back
      // restores it. Other types start empty and accumulate as visited.
      valuesByType: { [row.type]: row.value },
      disabled: row.disabled,
      comment: row.comment,
      valueTouched: true,
    });
  }

  async function handleDeleteRow(row: RecordRow) {
    const ok = await confirm({
      title: "Delete this record?",
      description: `Removes ${row.type} value "${row.value}" from ${displayName(row.name, props.zoneName) || "@"}. Other ${row.type} records on this name (if any) stay.`,
      confirmLabel: "Delete record",
      variant: "danger",
    });
    if (!ok) return;
    // Always read through the ref — the memoized cell closure may be
    // older than the current props.rrsets, so the closure-captured
    // `nonSoa` could miss records created earlier this session.
    const currentNonSoa = nonSoaRef.current;
    const change = buildDeleteChange(currentNonSoa, row);
    if (!change) {
      console.error("buildDeleteChange returned null", {
        rowName: row.name,
        rowType: row.type,
        rowValue: row.value,
        rowRecordIdx: row.recordIdx,
        nonSoaCount: currentNonSoa.length,
      });
      toast({
        kind: "error",
        title: "Could not delete",
        description:
          "The record isn't in the current view — it may have been removed in another session. Try reloading.",
      });
      router.refresh();
      return;
    }
    await applyPatch({
      changes: [change],
      rrsetsAfter: applyChangesToRRsets(currentNonSoa, [change]),
      summary: "Record deleted.",
    });
  }

  /**
   * Validate the editor draft and stage a patch for the review dialog. The
   * caller already confirmed the override toggle (when needed).
   *
   * Supports rename: when the actor changes name or type on an edit, the
   * patch emits a DELETE-or-shrink for the original (name, type) plus an
   * UPSERT-or-append for the new (name, type), in a single API call.
   */
  function handleEditorReview() {
    if (!editor) return;
    setEditorError(null);
    // Flip touched on submit so any validation issues we were hiding
    // (user clicked Review without ever blurring) become visible.
    setEditor({ ...editor, valueTouched: true });

    if (editor.value.trim() === "") {
      setEditorError("Value is required.");
      return;
    }
    if (editor.ttl < 0 || !Number.isInteger(editor.ttl)) {
      setEditorError("TTL must be a non-negative integer.");
      return;
    }
    if (editor.type === "SOA") {
      setEditorError("Edit SOA through the SOA panel above the records table.");
      return;
    }

    const validation = getRRTypeValidator(editor.type).validate(editor.value);
    if (hasErrors(validation) && !overrideErrors) {
      // Surface errors inline — the form already shows the list; this is the
      // generic catch-all message under the save button.
      setEditorError(
        "The value has validation errors. Fix them or tick 'Save anyway' to override.",
      );
      return;
    }

    const canonicalName = canonicalizeName(editor.name, props.zoneName);
    const canonicalType = editor.type.toUpperCase();

    if (editor.mode === "edit" && editor.originalRow) {
      const sameKey =
        editor.originalRow.name === canonicalName && editor.originalRow.type === canonicalType;
      const targetIsNewKey = !sameKey;
      if (
        targetIsNewKey &&
        nonSoa.some((rr) => rr.name === canonicalName && rr.type === canonicalType) &&
        canonicalType === "CNAME"
      ) {
        setEditorError(
          "An RRset already exists at the new name and CNAME can't coexist with other types or values there (RFC 1034 § 3.6.2). Delete it first or pick a different name.",
        );
        return;
      }
    }

    const changes = buildRecordChanges({
      current: nonSoa,
      original: editor.mode === "edit" ? (editor.originalRow ?? null) : null,
      target: {
        name: canonicalName,
        type: canonicalType,
        ttl: editor.ttl,
        value: validation.normalized,
        disabled: editor.disabled,
        comment: editor.comment,
      },
    });

    if (changes.length === 0) {
      setEditorError("Nothing to change.");
      return;
    }

    // Block no-op submits — Edit → Review → Apply with no actual change
    // would burn an audit row and a PDNS PATCH for nothing. Compare the
    // post-change RRset state against the pre-change state; on equality,
    // refuse with an inline message.
    const rrsetsAfter = applyChangesToRRsets(nonSoa, changes);
    if (rrsetsEqual(nonSoa, rrsetsAfter)) {
      setEditorError(
        editor.mode === "edit"
          ? "No changes to apply — the new values match the current record."
          : "Nothing to change.",
      );
      return;
    }

    setPending({
      changes,
      rrsetsAfter,
      summary:
        editor.mode === "create"
          ? "Record created."
          : changes.length > 1
            ? "Record moved."
            : "Record saved.",
    });
  }

  /**
   * Order-insensitive deep equality for the no-op guard. RRsets are equal
   * when they share (name, type, ttl) and the same multiset of
   * (content, disabled) record entries.
   */
  function rrsetsEqual(a: RRsetView[], b: RRsetView[]): boolean {
    if (a.length !== b.length) return false;
    const indexed = new Map(a.map((rr) => [`${rr.name}|${rr.type}`, rr]));
    for (const rr of b) {
      const prev = indexed.get(`${rr.name}|${rr.type}`);
      if (!prev) return false;
      if (prev.ttl !== rr.ttl) return false;
      if ((prev.comment ?? "") !== (rr.comment ?? "")) return false;
      if (prev.records.length !== rr.records.length) return false;
      const norm = (r: { content: string; disabled?: boolean }) =>
        `${r.disabled ? "!" : ""}${r.content}`;
      const sortedPrev = prev.records.map(norm).sort();
      const sortedNext = rr.records.map(norm).sort();
      for (let i = 0; i < sortedPrev.length; i++) {
        if (sortedPrev[i] !== sortedNext[i]) return false;
      }
    }
    return true;
  }

  async function applyPatch(patch: PendingPatch): Promise<void> {
    setSaving(true);
    try {
      const result = await mutate(`/api/admin/pdns/zones/${props.zoneIdEncoded}/rrsets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverSlug: props.serverSlug,
          changes: patch.changes.map((c) =>
            c.kind === "upsert"
              ? {
                  kind: "upsert" as const,
                  name: c.name,
                  type: c.type,
                  ttl: c.ttl ?? DEFAULT_TTL,
                  records: c.records ?? [],
                  ...(c.comment !== undefined ? { comment: c.comment } : {}),
                }
              : {
                  kind: "delete" as const,
                  name: c.name,
                  type: c.type,
                },
          ),
        }),
      });

      if (!result.ok) {
        toast({
          kind: "error",
          title: "Save failed",
          description: result.error,
        });
        return;
      }

      const body = result.data as {
        notified?: boolean;
        notifyError?: string;
      } | null;
      const notifySuffix = body?.notifyError
        ? ` NOTIFY failed: ${body.notifyError}`
        : body?.notified
          ? " Secondaries notified."
          : "";
      toast({
        kind: body?.notifyError ? "warn" : "success",
        description: patch.summary + notifySuffix,
      });
      setEditor(null);
      setPending(null);
      setOverrideErrors(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // ===== Render =============================================================

  const liveValidation = editor ? getRRTypeValidator(editor.type).validate(editor.value) : null;
  // Two gates control whether we show validation feedback:
  //   1. The value field must have content (don't tell the user "Not a valid
  //      IPv4 address" before they've typed anything).
  //   2. The user must have touched the field (blurred at least once, or
  //      clicked Review). Mid-keystroke noise while typing a fresh value is
  //      worse UX than waiting one blur for feedback.
  // Edit-mode starts with touched=true so existing-record issues surface
  // immediately on open.
  const valueIsNonEmpty = (editor?.value.trim() ?? "") !== "";
  const showValidation =
    liveValidation !== null && valueIsNonEmpty && editor?.valueTouched === true;
  const hasValidationErrors = showValidation && liveValidation ? hasErrors(liveValidation) : false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {props.canCreate ? (
          <button type="button" onClick={openCreate} className={createCtaClass}>
            <Plus className="h-4 w-4" aria-hidden />
            Add record
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        searchPlaceholder="Search records by name, type, value…"
        noDataMessage="No records on this zone yet."
        initialSort={[{ id: "name", desc: false }]}
        stateKey="records"
        layout="fixed"
      />

      {/* Editor dialog ====================================================== */}
      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === "edit" ? "Edit record" : "Add record"}
        maxWidthClass="max-w-xl"
      >
        {editor ? (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Name"
                hint={
                  'Relative ("www") or "@" for the zone apex. Changing this moves the record to a different RRset.'
                }
              >
                <input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder="www"
                  className={inputClass}
                />
              </Field>
              <Field
                label="Type"
                hint={
                  editor.mode === "edit"
                    ? "Changing type moves the record to a different RRset. The value field clears so it can be re-validated."
                    : undefined
                }
              >
                {/* Allow-list narrowed by zone kind (reverse zones drop A,
                    MX, SRV, … forward zones drop PTR). If we're editing
                    an existing record whose type sits outside that menu
                    (legacy data), thread it back in as the first option
                    so the operator can still see + save the row. */}
                <SelectMenu
                  value={editor.type}
                  onChange={(nextType) => {
                    if (nextType === editor.type) return;
                    // Park the current type's value, restore the next type's
                    // (or "" if we've never visited it during this session).
                    const stash = { ...editor.valuesByType, [editor.type]: editor.value };
                    const restored = stash[nextType] ?? "";
                    setEditor({
                      ...editor,
                      type: nextType,
                      value: restored,
                      valuesByType: stash,
                      valueTouched: restored !== "",
                    });
                  }}
                  options={(() => {
                    const allowed = typesForZone(props.zoneName);
                    const opts =
                      editor.mode === "edit" && !allowed.includes(editor.type)
                        ? [editor.type, ...allowed]
                        : allowed;
                    return opts.map((t) => ({ value: t, label: t }));
                  })()}
                  ariaLabel="Type"
                  className="mt-1 w-full"
                />
              </Field>
            </div>

            {/* Rename hint — only shows when (name, type) diverges from the
                edited row's original key. */}
            {editor.mode === "edit" && editor.originalRow
              ? renderRenameHint(editor, editor.originalRow, props.zoneName)
              : null}

            <Field
              label="TTL (seconds)"
              hint={
                editor.mode === "edit"
                  ? "Applies to the whole RRset — changing it here changes the TTL for every value with this name+type."
                  : undefined
              }
            >
              <NumberInput
                value={editor.ttl}
                onChange={(n) => setEditor({ ...editor, ttl: n })}
                min={0}
                className={inputClass}
              />
            </Field>

            <Field
              label="Value"
              hint={`${getRRTypeValidator(editor.type).label}. ${getRRTypeValidator(editor.type).description}`}
            >
              <RRContentField
                key={editor.type}
                type={editor.type}
                value={editor.value}
                onChange={(next) => setEditor({ ...editor, value: next, valueTouched: true })}
                fallbackPlaceholder={getRRTypeValidator(editor.type).placeholder}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editor.disabled}
                onChange={(e) => setEditor({ ...editor, disabled: e.target.checked })}
              />
              Disabled (served as NXDOMAIN, kept in the zone for history)
            </label>

            <Field
              label="Comment"
              hint="Free-form note attached to the rrset (shared by every value of this name + type)."
            >
              <textarea
                value={editor.comment}
                onChange={(e) => setEditor({ ...editor, comment: e.target.value })}
                rows={2}
                placeholder="Optional"
                className={inputClass}
              />
            </Field>

            {showValidation ? <ValidationIssues result={liveValidation} /> : null}

            {hasValidationErrors ? (
              <label className="flex items-start gap-2 rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={overrideErrors}
                  onChange={(e) => setOverrideErrors(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Save anyway — I&apos;ve reviewed the validation errors and want to publish this
                  content. The audit log captures the saved value verbatim.
                </span>
              </label>
            ) : null}

            {editorError ? (
              <p className="text-sm text-[color:var(--color-error)]" role="alert">
                {editorError}
              </p>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditor(null)}
                className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleEditorReview}
                disabled={hasValidationErrors && !overrideErrors}
                data-dialog-focus="true"
                className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
              >
                Review changes
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* Review dialog ====================================================== */}
      <Dialog
        open={pending !== null}
        onClose={() => (saving ? undefined : setPending(null))}
        title="Review changes"
        dismissOnBackdrop={false}
        maxWidthClass="max-w-[96rem]"
      >
        {pending ? (
          <div className="mt-4 space-y-4">
            {(() => {
              const { removed, added } = computeBindDiff(nonSoa, pending.rrsetsAfter);
              return (
                <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
                  <BareDiff removed={removed} added={added} />
                </div>
              );
            })()}
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPending(null)}
                disabled={saving}
                className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                data-dialog-focus="true"
                onClick={() => {
                  // Defensive: surface diagnostics if anything would
                  // make this click a no-op. Previously this swallowed
                  // a `pending=null` race silently — the user saw no
                  // request fire and no error.
                  if (saving) {
                    toast({
                      kind: "warn",
                      description: "A save is already in progress — please wait.",
                    });
                    return;
                  }
                  if (!pending) {
                    toast({
                      kind: "error",
                      title: "Could not apply",
                      description: "Lost track of pending changes. Close this dialog and re-edit.",
                    });
                    return;
                  }
                  void applyPatch(pending);
                }}
                disabled={saving}
                className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

// =============================================================================
// Display helpers
// =============================================================================

function ValidationIssues({ result }: { result: RRValidationResult | null }) {
  if (!result || result.issues.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {result.issues.map((issue, idx) => (
        <li
          key={idx}
          className={
            issue.level === "error"
              ? "text-[color:var(--color-error)]"
              : "text-[color:var(--color-warn)]"
          }
        >
          <span className="font-medium tracking-wide uppercase">{issue.level}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{hint}</p> : null}
    </div>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]";

// =============================================================================
// RRset ↔ row conversion
// =============================================================================

function flattenRrsetsToRows(rrsets: RRsetView[], zoneName: string): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const rr of rrsets) {
    rr.records.forEach((r, idx) => {
      rows.push({
        name: rr.name,
        type: rr.type,
        ttl: rr.ttl,
        value: r.content,
        disabled: r.disabled === true,
        recordIdx: idx,
        comment: rr.comment,
      });
    });
  }
  return rows.sort((a, b) => {
    const nameCmp = compareDnsNames(a.name, b.name, zoneName);
    if (nameCmp !== 0) return nameCmp;
    const typeCmp = compareTypes(a.type, b.type);
    if (typeCmp !== 0) return typeCmp;
    return a.value.localeCompare(b.value);
  });
}

function buildDeleteChange(current: RRsetView[], row: RecordRow): PatchChange | null {
  const rr = current.find((r) => r.name === row.name && r.type === row.type);
  if (!rr) return null;
  const remaining = rr.records.filter(
    (r, idx) => !(r.content === row.value && idx === row.recordIdx),
  );
  if (remaining.length === 0) {
    return { kind: "delete", name: row.name, type: row.type };
  }
  return {
    kind: "upsert",
    name: row.name,
    type: row.type,
    ttl: rr.ttl,
    records: remaining,
  };
}

/**
 * Build the PDNS PATCH change-list for an editor submit. Handles four cases:
 *
 *   - Create: emit one upsert. If the (name, type) already has values, the
 *     new record appends to that RRset (deduped on (content, disabled)).
 *   - Edit, same (name, type): emit one upsert that replaces the value at
 *     the row's `recordIdx` within the existing RRset.
 *   - Edit, renamed (name, type): emit *two* operations in one patch — one
 *     to shrink (or delete) the original RRset, one to append-or-create
 *     the new RRset.
 *   - No-op: returns [].
 *
 * The two-operation rename is atomic at the PDNS layer because the API
 * applies all changes in a single PATCH.
 */
function buildRecordChanges(args: {
  current: RRsetView[];
  original: RecordRow | null;
  target: {
    name: string;
    type: string;
    ttl: number;
    value: string;
    disabled: boolean;
    comment: string;
  };
}): PatchChange[] {
  const { current, original, target } = args;
  const targetExisting = current.find((rr) => rr.name === target.name && rr.type === target.type);

  // ── Create path ──────────────────────────────────────────────────────────
  if (!original) {
    const records = targetExisting
      ? dedupeAppend(targetExisting.records, {
          content: target.value,
          disabled: target.disabled,
        })
      : [{ content: target.value, disabled: target.disabled }];
    return [
      {
        kind: "upsert",
        name: target.name,
        type: target.type,
        ttl: target.ttl,
        records,
        comment: target.comment,
      },
    ];
  }

  const originalRrset = current.find(
    (rr) => rr.name === original.name && rr.type === original.type,
  );
  if (!originalRrset) return [];

  const sameKey = original.name === target.name && original.type === target.type;

  // ── Edit path, same key ─────────────────────────────────────────────────
  if (sameKey) {
    const records = originalRrset.records.map((r, idx) =>
      idx === original.recordIdx ? { content: target.value, disabled: target.disabled } : r,
    );
    return [
      {
        kind: "upsert",
        name: target.name,
        type: target.type,
        ttl: target.ttl,
        records,
        comment: target.comment,
      },
    ];
  }

  // ── Edit path, rename: source shrink + target append ────────────────────
  const changes: PatchChange[] = [];
  const remaining = originalRrset.records.filter((_r, idx) => idx !== original.recordIdx);
  if (remaining.length === 0) {
    changes.push({
      kind: "delete",
      name: original.name,
      type: original.type,
    });
  } else {
    changes.push({
      kind: "upsert",
      name: original.name,
      type: original.type,
      ttl: originalRrset.ttl,
      records: remaining,
      // Preserve the original rrset's comment when shrinking — the
      // operator didn't intend to clear it just by moving one record out.
      comment: originalRrset.comment,
    });
  }

  const newRecord = { content: target.value, disabled: target.disabled };
  const targetRecords = targetExisting
    ? dedupeAppend(targetExisting.records, newRecord)
    : [newRecord];
  changes.push({
    kind: "upsert",
    name: target.name,
    type: target.type,
    ttl: target.ttl,
    records: targetRecords,
    comment: target.comment,
  });

  return changes;
}

function dedupeAppend(existing: RecordValue[], next: RecordValue): RecordValue[] {
  const dup = existing.some(
    (r) => r.content === next.content && (r.disabled ?? false) === (next.disabled ?? false),
  );
  return dup ? existing : [...existing, next];
}

/** Banner shown in the editor when an edit's (name, type) diverges from
 *  the original row's key — makes "this is a move, not an in-place edit"
 *  unmistakable to the operator before they click Review. */
function renderRenameHint(
  editor: EditorState,
  original: RecordRow,
  zoneName: string,
): React.ReactNode {
  const fromName = displayName(original.name, zoneName) || "@";
  const toName = editor.name.trim() || "@";
  const fromType = original.type;
  const toType = editor.type.toUpperCase();
  if (fromName === toName && fromType === toType) return null;
  return (
    <p className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 px-3 py-2 text-xs text-[color:var(--color-warn)]">
      Moving record:{" "}
      <code className="font-mono">
        {fromName} {fromType}
      </code>{" "}
      →{" "}
      <code className="font-mono">
        {toName} {toType}
      </code>
      . The old RRset shrinks (or is deleted if empty) and the new RRset gains this value.
    </p>
  );
}

function applyChangesToRRsets(current: RRsetView[], changes: PatchChange[]): RRsetView[] {
  let out = current.slice();
  for (const c of changes) {
    if (c.kind === "delete") {
      out = out.filter((rr) => !(rr.name === c.name && rr.type === c.type));
    } else {
      const idx = out.findIndex((rr) => rr.name === c.name && rr.type === c.type);
      const existing = idx === -1 ? null : out[idx]!;
      const updated: RRsetView = {
        name: c.name,
        type: c.type,
        ttl: c.ttl ?? DEFAULT_TTL,
        records: c.records ?? [],
        comment: c.comment ?? existing?.comment ?? "",
      };
      if (idx === -1) out = [...out, updated];
      else {
        const next = out.slice();
        next[idx] = updated;
        out = next;
      }
    }
  }
  return out;
}

// =============================================================================
// Name + sort helpers (unchanged from prior version)
// =============================================================================

function displayName(name: string, zoneName: string): string {
  if (name === zoneName) return "";
  if (name.endsWith(`.${zoneName}`)) {
    return name.slice(0, name.length - zoneName.length - 1);
  }
  return name;
}

function canonicalizeName(input: string, zoneName: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zoneName;
  if (trimmed.endsWith(".")) return trimmed;
  return `${trimmed}.${zoneName}`;
}

function compareDnsNames(left: string, right: string, zoneName: string): number {
  const leftIsApex = left === zoneName;
  const rightIsApex = right === zoneName;
  if (leftIsApex && !rightIsApex) return -1;
  if (rightIsApex && !leftIsApex) return 1;
  if (leftIsApex && rightIsApex) return 0;

  const leftLabels = reverseLabels(left);
  const rightLabels = reverseLabels(right);
  const len = Math.min(leftLabels.length, rightLabels.length);
  for (let i = 0; i < len; i++) {
    const cmp = leftLabels[i]!.localeCompare(rightLabels[i]!);
    if (cmp !== 0) return cmp;
  }
  return leftLabels.length - rightLabels.length;
}

function reverseLabels(name: string): string[] {
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  return trimmed.split(".").reverse();
}

function compareTypes(left: string, right: string): number {
  const priority = (type: string): number => {
    if (type === "NS") return 0;
    return 1;
  };
  const pa = priority(left);
  const pb = priority(right);
  if (pa !== pb) return pa - pb;
  return left.localeCompare(right);
}
