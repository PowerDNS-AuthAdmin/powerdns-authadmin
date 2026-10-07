"use client";

/**
 * app/(app)/zones/[zoneId]/_components/editable-record-table.tsx
 *
 * Interactive zone editor. Each (name, type, value) is its own row - a
 * single `www A` RRset with three IPs renders as three rows, edited /
 * deleted independently. On save the editor groups rows back into RRsets
 * (PDNS's atomic unit) and emits one REPLACE per (name, type).
 *
 * Two ways to edit, one way to save:
 *
 *   - **Inline strip** (Enter on a row, double-click, or the Edit button):
 *     TTL, value and the disabled flag edited right under the row. Covers
 *     the everyday "bump this IP" change without leaving the table.
 *   - **Full dialog** (E, the ⋯ button, or "Full editor…" from the strip):
 *     adds name, type and comment - anything that moves the record to a
 *     different RRset - plus the "save anyway" override.
 *
 *   Both stage their change through `stageDraft` into the same diff review
 *   dialog, so there is exactly one path to PowerDNS and one set of checks.
 *
 * Keyboard: `/` search, `N` add, ↑/↓ rows, Enter / E / Delete on a row,
 * Enter reviews a draft, Esc backs out at every level.
 *
 * SOA is intentionally absent: it's edited through `<SoaPanel>` above the
 * records table, and filtered out of every view here (table, type dropdown,
 * BIND diff).
 *
 * Validation: each record's content runs through the per-RR-type validator
 * in `lib/validators/rr-types/`. Errors block save by default; the operator
 * can tick "Save anyway" to override (RFC-borderline content with a known-
 * good intent gets through). Warnings never block - they just inform.
 */

import { useRouter } from "next/navigation";
import { cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Plus } from "lucide-react";
import { Dialog, useDialog } from "@/components/ui/dialog";
import { DataTable, isTypingTarget, type RowProps } from "@/components/ui/data-table";
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
import { protectedRRsetPermission } from "@/lib/rbac/protected-rrsets";
import type { DefaultTtlSource, ResolvedDefaultTtl } from "@/lib/dns/default-ttl";
import { BareDiff, computeBindDiff } from "./bare-diff";
import { NumberInput } from "@/components/ui/number-input";
import { getRREditor, RRContentField } from "@/components/domain/rr-editors";
import { Field as EditorField } from "@/components/domain/rr-editors/_form";
import { Switch } from "@/components/ui/switch";

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

/** Flattened single-value row - what the table renders. */
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
  /**
   * `record.update.apex-ns`. The apex NS RRset is the zone's delegation,
   * so it costs a permission of its own on top of the record ones (#119).
   * Without it those rows render locked and the editor refuses to stage a
   * change touching them - the RRset route enforces the same rule, this
   * just stops the operator finding out via a 403.
   */
  canUpdateApexNs: boolean;
  /** Live ENABLE-LUA-RECORDS=1 state for this zone. */
  luaRecordsEnabled: boolean;
  /** TTL a new record starts with, and where it came from (zone / global / built-in). */
  defaultTtl: ResolvedDefaultTtl;
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
   * Validation visibility gate - see the inline comment near the value input
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
   * preserves whatever PDNS already has - important for record edits
   * that don't touch the comment.
   */
  comment?: string;
}

const DEFAULT_TTL_ORIGIN: Record<DefaultTtlSource, string> = {
  zone: "this zone's default (X-AUTHADMIN-DEFAULT-TTL metadata)",
  global: "the default in Settings",
  builtin: "the built-in default",
};

export function EditableRecordTable(props: EditableRecordTableProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();

  // SOA never appears in the records UI - it's owned by <SoaPanel>.
  const nonSoa = useMemo(() => props.rrsets.filter((rr) => rr.type !== "SOA"), [props.rrsets]);

  // Mirror the latest snapshot into a ref so closures inside the
  // memoized columns (which don't include `nonSoa` in their deps -
  // re-memoizing on every prop change would thrash TanStack's
  // internal table instance) can still read the freshest data.
  // Without this ref, the Delete button's cached closure would call
  // buildDeleteChange against a STALE nonSoa, missing records that
  // were created earlier in the same page lifecycle - that's the
  // "delete a freshly-created record silently no-ops" bug.
  const nonSoaRef = useRef(nonSoa);
  nonSoaRef.current = nonSoa;

  const rows = useMemo(() => flattenRrsetsToRows(nonSoa, props.zoneName), [nonSoa, props.zoneName]);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [overrideErrors, setOverrideErrors] = useState(false);
  const [pending, setPending] = useState<PendingPatch | null>(null);
  const [saving, setSaving] = useState(false);
  // In-place editor for one row (TTL, value, disabled). Lives under the row
  // as an expansion strip; anything that changes the RRset key (name, type)
  // or the comment escalates to the full dialog.
  const [inline, setInline] = useState<InlineDraft | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const showActions = props.canUpdate || props.canDelete;

  /**
   * True when this row is an apex NS the actor may not touch. Uses the
   * same classifier the RRset route does, so the lock and the 403 can't
   * drift apart.
   */
  const isLockedRow = (row: { name: string; type: string }): boolean =>
    !props.canUpdateApexNs &&
    protectedRRsetPermission(row.name, row.type, props.zoneName) === "record.update.apex-ns";

  // If the row under inline edit vanished (saved, deleted elsewhere, zone
  // reloaded), drop the strip rather than keep a draft nothing anchors to.
  useEffect(() => {
    if (!inline) return;
    if (!rows.some((r) => rowKey(r) === rowKey(inline.row))) setInline(null);
  }, [rows, inline]);

  // Page-level shortcut: "n" opens Add record. Stays out of the way while
  // typing and while any dialog is open.
  useEffect(() => {
    if (!props.canCreate) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      openCreate();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // openCreate only reads props through the closure it's defined in; the
    // listener is re-bound whenever canCreate flips, which is all it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.canCreate]);

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
            <span className="text-xs text-[color:var(--color-fg-subtle)]">-</span>
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
          if (isLockedRow(row)) {
            return (
              <span
                className="text-xs text-[color:var(--color-fg-subtle)]"
                title="The apex NS records are this zone's delegation. Editing them needs record.update.apex-ns."
              >
                Delegation - locked
              </span>
            );
          }
          return (
            <span className="inline-flex items-center gap-1 text-xs">
              {props.canUpdate ? (
                <button
                  type="button"
                  onClick={() => openInline(row)}
                  title="Edit TTL and value in place (Enter)"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-subtle)] hover:underline"
                >
                  <Pencil className="h-3 w-3" aria-hidden />
                  Edit
                </button>
              ) : null}
              {props.canUpdate ? (
                <button
                  type="button"
                  onClick={() => openEdit(row)}
                  title="Full editor: rename, change type, comment (E)"
                  aria-label="Open full editor"
                  className="rounded px-1.5 py-0.5 text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)]"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
              {props.canDelete ? (
                <button
                  type="button"
                  onClick={() => handleDeleteRow(row)}
                  title="Delete this value (Delete)"
                  className="rounded px-1.5 py-0.5 text-[color:var(--color-error)] hover:bg-[color:var(--color-bg-subtle)] hover:underline"
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
    // openEdit/openInline/handleDeleteRow are intentionally omitted: all are
    // stale-safe by construction (functional setState + handleDeleteRow reads
    // the live `nonSoaRef.current`, see below), so rebuilding the column defs
    // when they change would be churn without correctness benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.canUpdate, props.canDelete, props.canUpdateApexNs, props.zoneName, showActions]);

  // ===== Editor handlers =====================================================

  function openCreate() {
    setInline(null);
    setEditorError(null);
    setOverrideErrors(false);
    setEditor({
      mode: "create",
      name: "",
      // Reverse zones default to PTR; forward zones default to A. Saves the
      // operator the extra dropdown click on the common case for that zone.
      type: defaultTypeForZone(props.zoneName),
      ttl: props.defaultTtl.ttl,
      value: "",
      valuesByType: {},
      disabled: false,
      comment: "",
      valueTouched: false,
    });
  }

  /**
   * Open the full dialog for a row. When an inline draft for the same row
   * is in progress its TTL / value / disabled edits carry over, so "I need
   * to rename this too" doesn't throw away what was already typed.
   */
  function openEdit(row: RecordRow) {
    if (isLockedRow(row)) return;
    const draft = inline && rowKey(inline.row) === rowKey(row) ? inline : null;
    setInline(null);
    setEditorError(null);
    setOverrideErrors(false);
    setEditor({
      mode: "edit",
      originalRow: row,
      name: displayName(row.name, props.zoneName),
      type: row.type,
      ttl: draft?.ttl ?? row.ttl,
      value: draft?.value ?? row.value,
      // Seed with the original type's value so switching away and back
      // restores it. Other types start empty and accumulate as visited.
      valuesByType: { [row.type]: draft?.value ?? row.value },
      disabled: draft?.disabled ?? row.disabled,
      comment: row.comment,
      valueTouched: true,
    });
  }

  function openInline(row: RecordRow) {
    if (isLockedRow(row) || !props.canUpdate) return;
    setInlineError(null);
    setInline({ row, ttl: row.ttl, value: row.value, disabled: row.disabled });
  }

  function closeInline() {
    setInline(null);
    setInlineError(null);
  }

  async function handleDeleteRow(row: RecordRow) {
    if (isLockedRow(row)) return;
    const ok = await confirm({
      title: "Delete this record?",
      description: `Removes ${row.type} value "${row.value}" from ${displayName(row.name, props.zoneName) || "@"}. Other ${row.type} records on this name (if any) stay.`,
      confirmLabel: "Delete record",
      variant: "danger",
    });
    if (!ok) return;
    // Always read through the ref - the memoized cell closure may be
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
          "The record isn't in the current view - it may have been removed in another session. Try reloading.",
      });
      router.refresh();
      return;
    }
    await applyPatch({
      changes: [change],
      rrsetsAfter: applyChangesToRRsets(currentNonSoa, [change], props.defaultTtl.ttl),
      summary: "Record deleted.",
    });
  }

  /**
   * Validate a draft and stage a patch for the review dialog. Shared by the
   * full dialog and the inline strip - both end in the same diff review, so
   * every path to PowerDNS goes through one set of checks.
   *
   * Returns an error message to show next to the draft, or `null` when the
   * patch was staged.
   *
   * Supports rename: when the actor changes name or type on an edit, the
   * patch emits a DELETE-or-shrink for the original (name, type) plus an
   * UPSERT-or-append for the new (name, type), in a single API call.
   */
  function stageDraft(draft: StagedDraft): string | null {
    if (draft.value.trim() === "") return "Value is required.";
    if (draft.ttl < 0 || !Number.isInteger(draft.ttl)) {
      return "TTL must be a non-negative integer.";
    }
    if (draft.type === "SOA") return "Edit SOA through the SOA panel above the records table.";
    if (draft.type === "LUA" && !props.luaRecordsEnabled) {
      return "LUA records require ENABLE-LUA-RECORDS to be set to 1 in this zone's metadata.";
    }

    const validation = getRRTypeValidator(draft.type).validate(draft.value);
    if (hasErrors(validation) && !draft.overrideErrors) {
      // Surface errors inline - the form already shows the list; this is the
      // generic catch-all message under the save button.
      return "The value has validation errors. Fix them or tick 'Save anyway' to override.";
    }

    const canonicalName = canonicalizeName(draft.name, props.zoneName);
    const canonicalType = draft.type.toUpperCase();

    if (draft.originalRow) {
      const sameKey =
        draft.originalRow.name === canonicalName && draft.originalRow.type === canonicalType;
      if (
        !sameKey &&
        canonicalType === "CNAME" &&
        nonSoa.some((rr) => rr.name === canonicalName && rr.type === canonicalType)
      ) {
        return "An RRset already exists at the new name and CNAME can't coexist with other types or values there (RFC 1034 § 3.6.2). Delete it first or pick a different name.";
      }
    }

    const changes = buildRecordChanges({
      current: nonSoa,
      original: draft.originalRow ?? null,
      target: {
        name: canonicalName,
        type: canonicalType,
        ttl: draft.ttl,
        value: validation.normalized,
        disabled: draft.disabled,
        comment: draft.comment,
      },
    });

    if (changes.length === 0) return "Nothing to change.";

    // A rename can move a record ONTO the apex NS RRset (or off it), so
    // check the changes the edit actually produces rather than the form's
    // target alone. The RRset route rejects the same set - this just says
    // so before the operator has staged a diff.
    if (changes.some((c) => isLockedRow(c))) {
      return "The apex NS records are this zone's delegation and need the record.update.apex-ns permission.";
    }

    // Block no-op submits - Edit → Review → Apply with no actual change
    // would burn an audit row and a PDNS PATCH for nothing. Compare the
    // post-change RRset state against the pre-change state; on equality,
    // refuse with an inline message.
    const rrsetsAfter = applyChangesToRRsets(nonSoa, changes, props.defaultTtl.ttl);
    if (rrsetsEqual(nonSoa, rrsetsAfter)) {
      return draft.originalRow
        ? "No changes to apply - the new values match the current record."
        : "Nothing to change.";
    }

    setPending({
      changes,
      rrsetsAfter,
      summary: !draft.originalRow
        ? "Record created."
        : changes.length > 1
          ? "Record moved."
          : "Record saved.",
    });
    return null;
  }

  function handleEditorReview() {
    if (!editor) return;
    setEditorError(null);
    // Flip touched on submit so any validation issues we were hiding
    // (user clicked Review without ever blurring) become visible.
    setEditor({ ...editor, valueTouched: true });
    const error = stageDraft({
      originalRow: editor.mode === "edit" ? editor.originalRow : undefined,
      name: editor.name,
      type: editor.type,
      ttl: editor.ttl,
      value: editor.value,
      disabled: editor.disabled,
      comment: editor.comment,
      overrideErrors,
    });
    if (error) setEditorError(error);
  }

  function handleInlineReview() {
    if (!inline) return;
    setInlineError(null);
    const error = stageDraft({
      originalRow: inline.row,
      name: displayName(inline.row.name, props.zoneName),
      type: inline.row.type,
      ttl: inline.ttl,
      value: inline.value,
      disabled: inline.disabled,
      comment: inline.row.comment,
      // The strip has no "save anyway" - validation errors send the operator
      // to the full editor, which carries the draft across and offers it.
      overrideErrors: false,
    });
    if (error) setInlineError(error);
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
                  ttl: c.ttl ?? props.defaultTtl.ttl,
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
      setInline(null);
      setInlineError(null);
      setOverrideErrors(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  // ===== Row keyboard model ===================================================

  /**
   * Rows are focusable so the table drives from the keyboard: ↑/↓ move,
   * Enter edits in place, E opens the full editor, Delete deletes. Keys
   * typed inside the inline strip never reach here - the strip is its own
   * row.
   */
  function rowProps(row: RecordRow): RowProps {
    const editable = showActions && !isLockedRow(row);
    const editing = inline !== null && rowKey(inline.row) === rowKey(row);
    return {
      tabIndex: editable ? 0 : -1,
      "data-editing": editing ? "true" : undefined,
      className: editing
        ? "bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] shadow-[inset_2px_0_0_var(--color-accent)]"
        : undefined,
      onDoubleClick: (e) => {
        if (!editable || !props.canUpdate) return;
        if ((e.target as HTMLElement).closest("a,button,input,textarea,label")) return;
        openInline(row);
      },
      onKeyDown: (e) => {
        if (e.target !== e.currentTarget) return; // a control inside the row has focus
        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp": {
            e.preventDefault();
            focusSiblingRow(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
            return;
          }
          case "Enter":
            if (props.canUpdate && editable) {
              e.preventDefault();
              openInline(row);
            }
            return;
          case "e":
          case "E":
            if (props.canUpdate && editable && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              openEdit(row);
            }
            return;
          case "Delete":
          case "Backspace":
            if (props.canDelete && editable) {
              e.preventDefault();
              void handleDeleteRow(row);
            }
            return;
          case "Escape":
            if (editing) closeInline();
            return;
        }
      },
    };
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

  const typeOptions = useMemo(() => {
    // Allow-list narrowed by zone kind (reverse zones drop A, MX, SRV, …
    // forward zones drop PTR). If we're editing an existing record whose
    // type sits outside that menu (legacy data), thread it back in as the
    // first option so the operator can still see + save the row.
    const allowed = typesForZone(props.zoneName).filter(
      (type) => type !== "LUA" || props.luaRecordsEnabled,
    );
    const editing = editor?.mode === "edit" ? editor.type : null;
    const opts = editing && !allowed.includes(editing) ? [editing, ...allowed] : allowed;
    return opts.map((t) => ({ value: t, label: t, description: getRRTypeValidator(t).label }));
  }, [props.zoneName, props.luaRecordsEnabled, editor?.mode, editor?.type]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {props.canCreate ? (
          <button
            type="button"
            onClick={openCreate}
            className={createCtaClass}
            aria-keyshortcuts="n"
            title="Add record (N)"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add record
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        searchPlaceholder="Search records by name, type, value…"
        searchShortcut
        noDataMessage="No records on this zone yet."
        initialSort={[{ id: "name", desc: false }]}
        stateKey="records"
        layout="fixed"
        getRowProps={showActions ? rowProps : undefined}
        renderRowDetail={(row) =>
          inline && rowKey(inline.row) === rowKey(row) ? (
            <InlineRecordEditor
              key={rowKey(row)}
              draft={inline}
              zoneName={props.zoneName}
              error={inlineError}
              onChange={(next) => {
                setInlineError(null);
                setInline((cur) => (cur ? { ...cur, ...next } : cur));
              }}
              onReview={handleInlineReview}
              onCancel={closeInline}
              onOpenFull={() => openEdit(row)}
            />
          ) : null
        }
      />

      {showActions ? (
        <ShortcutLegend canCreate={props.canCreate} canDelete={props.canDelete} />
      ) : null}

      {/* Editor dialog ====================================================== */}
      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === "edit" ? "Edit record" : "Add record"}
        maxWidthClass="max-w-xl"
      >
        {editor ? (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleEditorReview();
            }}
            onKeyDown={(e) => {
              // Enter inside a textarea inserts a newline; Ctrl/⌘+Enter
              // submits from anywhere, matching the inline strip.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleEditorReview();
              }
            }}
          >
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
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Type"
                hint={
                  editor.mode === "edit"
                    ? "Changing type moves the record to a different RRset. The value field clears so it can be re-validated."
                    : "Type a letter to jump: T for TXT, T again for TLSA."
                }
              >
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
                  options={typeOptions}
                  searchPlaceholder="Filter types (TXT, mail, IPv6…)"
                  ariaLabel="Type"
                  className="mt-1 w-full"
                />
                {!props.luaRecordsEnabled ? (
                  <p className="mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]">
                    To add LUA records through AuthAdmin, set <code>ENABLE-LUA-RECORDS</code> to{" "}
                    <code>1</code> for this zone on the PowerDNS host.
                  </p>
                ) : null}
              </Field>
            </div>

            {/* Rename hint - only shows when (name, type) diverges from the
                edited row's original key. */}
            {editor.mode === "edit" && editor.originalRow
              ? renderRenameHint(editor, editor.originalRow, props.zoneName)
              : null}

            <Field
              label="TTL (seconds)"
              hint={
                editor.mode === "edit"
                  ? "Applies to the whole RRset - changing it here changes the TTL for every value with this name+type."
                  : `Pre-filled with ${props.defaultTtl.ttl} from ${DEFAULT_TTL_ORIGIN[props.defaultTtl.source]}.`
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
                  Save anyway - I&apos;ve reviewed the validation errors and want to publish this
                  content. The audit log captures the saved value verbatim.
                </span>
              </label>
            ) : null}

            {editorError ? (
              <p className="text-sm text-[color:var(--color-error)]" role="alert">
                {editorError}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
              <KeyHint className="mr-auto">
                <Kbd>Enter</Kbd> review · <Kbd>Esc</Kbd> cancel
              </KeyHint>
              <button
                type="button"
                onClick={() => setEditor(null)}
                className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={hasValidationErrors && !overrideErrors}
                className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
              >
                Review changes
              </button>
            </div>
          </form>
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
            <div className="flex flex-wrap items-center justify-end gap-3">
              <KeyHint className="mr-auto">
                <Kbd>Enter</Kbd> save · <Kbd>Esc</Kbd> back
              </KeyHint>
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
                  // a `pending=null` race silently - the user saw no
                  // request fire and no error.
                  if (saving) {
                    toast({
                      kind: "warn",
                      description: "A save is already in progress - please wait.",
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
// Inline editor strip
// =============================================================================

interface InlineDraft {
  row: RecordRow;
  ttl: number;
  value: string;
  disabled: boolean;
}

/** What both editors hand to `stageDraft`. `originalRow` is unset for a create. */
interface StagedDraft {
  originalRow?: RecordRow;
  name: string;
  type: string;
  ttl: number;
  value: string;
  disabled: boolean;
  comment: string;
  overrideErrors: boolean;
}

function rowKey(row: RecordRow): string {
  return `${row.name}|${row.type}|${row.recordIdx}`;
}

/**
 * Move focus to the previous/next focusable row, skipping detail rows (the
 * inline strip) that sit between data rows in the DOM.
 */
function focusSiblingRow(from: HTMLElement, direction: 1 | -1): void {
  let el: Element | null = from;
  while (el) {
    el = direction === 1 ? el.nextElementSibling : el.previousElementSibling;
    if (el instanceof HTMLElement && el.getAttribute("tabindex") === "0") {
      el.focus();
      return;
    }
  }
}

/**
 * The in-place editor rendered beneath a row. Edits TTL, value and the
 * disabled flag - the fields that don't change which RRset the record
 * belongs to. Enter stages the diff review, Esc cancels, and "Full editor"
 * hands the draft to the dialog for renames, type changes and comments.
 */
function InlineRecordEditor({
  draft,
  zoneName,
  error,
  onChange,
  onReview,
  onCancel,
  onOpenFull,
}: {
  draft: InlineDraft;
  zoneName: string;
  error: string | null;
  onChange: (next: Partial<Pick<InlineDraft, "ttl" | "value" | "disabled">>) => void;
  onReview: () => void;
  onCancel: () => void;
  onOpenFull: () => void;
}) {
  const rootRef = useRef<HTMLFormElement>(null);
  const validator = getRRTypeValidator(draft.row.type);
  const structured = getRREditor(draft.row.type) !== null;
  const validation = validator.validate(draft.value);
  const dirty =
    draft.value !== draft.row.value ||
    draft.ttl !== draft.row.ttl ||
    draft.disabled !== draft.row.disabled;

  // Land the cursor in the value field (first input of the structured
  // editor for MX/SRV/…, the single input otherwise) so Enter-on-row →
  // type → Enter is a closed loop.
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>(
      "[data-inline-value] input, [data-inline-value] textarea",
    );
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === "text") first.select();
  }, []);

  return (
    <form
      ref={rootRef}
      onSubmit={(e) => {
        e.preventDefault();
        onReview();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
          return;
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onReview();
        }
      }}
      aria-label={`Edit ${displayName(draft.row.name, zoneName) || "@"} ${draft.row.type}`}
      className="space-y-3 pt-3"
    >
      {/* One label row, one input row: every field here uses the structured
          editors' compact <Field> so TTL / Preference / Exchange / Disabled
          share a baseline. A structured type renders its own labelled fields,
          so it gets no extra "Value" label stacked on top. */}
      <div className="grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)_auto] md:items-start">
        <EditorField label="TTL">
          <NumberInput
            value={draft.ttl}
            onChange={(n) => onChange({ ttl: n })}
            min={0}
            className={inputClass}
          />
        </EditorField>
        <div data-inline-value>
          {structured ? (
            <>
              <RRContentField
                type={draft.row.type}
                value={draft.value}
                onChange={(next) => onChange({ value: next })}
                fallbackPlaceholder={validator.placeholder}
              />
              <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                {validator.description}
              </p>
            </>
          ) : (
            <EditorField label="Value" hint={validator.description}>
              <RRContentField
                type={draft.row.type}
                value={draft.value}
                onChange={(next) => onChange({ value: next })}
                fallbackPlaceholder={validator.placeholder}
              />
            </EditorField>
          )}
        </div>
        <EditorField label="Disabled">
          {/* Sized to the text inputs' box so the switch sits on the input row. */}
          <div className="mt-1 flex min-h-[2.375rem] items-center">
            <Switch
              checked={draft.disabled}
              onChange={(next) => onChange({ disabled: next })}
              ariaLabel="Disabled"
            />
          </div>
        </EditorField>
      </div>

      {draft.value.trim() !== "" ? <ValidationIssues result={validation} /> : null}
      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!dirty}
          className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          Review changes
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onOpenFull}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
          title="Rename, change the type, edit the comment, or save with validation errors"
        >
          Full editor…
        </button>
        <KeyHint className="ml-auto">
          <Kbd>Enter</Kbd> review · <Kbd>Esc</Kbd> cancel
        </KeyHint>
      </div>
    </form>
  );
}

/** One-line reminder of the table's keyboard model. Desktop only - there's no keyboard to speak of on a phone. */
function ShortcutLegend({ canCreate, canDelete }: { canCreate: boolean; canDelete: boolean }) {
  return (
    <KeyHint className="hidden flex-wrap gap-x-3 gap-y-1 md:flex">
      <span>
        <Kbd>/</Kbd> search
      </span>
      {canCreate ? (
        <span>
          <Kbd>N</Kbd> add record
        </span>
      ) : null}
      <span>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> rows
      </span>
      <span>
        <Kbd>Enter</Kbd> edit in place
      </span>
      <span>
        <Kbd>E</Kbd> full editor
      </span>
      {canDelete ? (
        <span>
          <Kbd>Del</Kbd> delete
        </span>
      ) : null}
    </KeyHint>
  );
}

function KeyHint({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-xs text-[color:var(--color-fg-muted)] ${className ?? ""}`}>{children}</p>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-1 py-px font-mono text-[0.65rem]">
      {children}
    </kbd>
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

/**
 * Label + control + hint. A single element child without an `id` gets one
 * so the label's `htmlFor` reaches it - clicking "TTL" focuses the TTL box
 * and screen readers announce the field by name.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const autoId = useId();
  const hintId = `${autoId}-hint`;
  let control = children;
  let controlId: string | undefined;
  if (isValidElement<{ id?: string; "aria-describedby"?: string }>(children)) {
    controlId = children.props.id ?? autoId;
    control = cloneElement(children, {
      id: controlId,
      ...(hint && !children.props["aria-describedby"] ? { "aria-describedby": hintId } : {}),
    });
  }
  return (
    <div>
      <label htmlFor={controlId} className="block text-sm font-medium">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          {hint}
        </p>
      ) : null}
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
 *   - Edit, renamed (name, type): emit *two* operations in one patch - one
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
      // Preserve the original rrset's comment when shrinking - the
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
 *  the original row's key - makes "this is a move, not an in-place edit"
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

function applyChangesToRRsets(
  current: RRsetView[],
  changes: PatchChange[],
  defaultTtl: number,
): RRsetView[] {
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
        ttl: c.ttl ?? defaultTtl,
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
