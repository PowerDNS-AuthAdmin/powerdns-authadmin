/**
 * components/domain/rr-editors/index.tsx
 *
 * Registry + orchestrator for the per-RR-type structured editors.
 *
 * The orchestrator chooses one of three modes based on the current value:
 *
 *   - **No registered editor** (A, AAAA, CNAME, NS, PTR, DNAME, OPENPGPKEY)
 *     - the type's wire format is already a single value; render a plain
 *     input. The caller's `<input>` styling stays - the orchestrator
 *     returns the same shape.
 *   - **Structured** - the value parses cleanly. Render the per-type
 *     fields plus an always-visible read-only preview of the wire format
 *     that will be serialized on save.
 *   - **Raw fallback** - the value is non-empty but doesn't parse into the
 *     structured form (legacy or hand-edited record). Render an editable
 *     textarea + a warning banner so the operator can still fix the
 *     record without losing in-place editing. Stays sticky for the
 *     lifetime of the dialog mount so a momentarily-valid edit doesn't
 *     yank focus into the structured mode mid-keystroke.
 */

"use client";

import { useCallback, useMemo, useState, type ReactElement } from "react";
import type { RREditor } from "./types";
import { mxEditor } from "./mx";
import { srvEditor } from "./srv";
import { caaEditor } from "./caa";
import { uriEditor } from "./uri";
import { naptrEditor } from "./naptr";
import { sshfpEditor } from "./sshfp";
import { tlsaEditor, smimeaEditor } from "./tlsa";
import { dsEditor } from "./ds";
import { txtEditor } from "./txt";
import { svcbEditor, httpsEditor } from "./svcb";
import { inputClass } from "./_form";

const REGISTRY: Record<string, RREditor<unknown>> = {
  MX: mxEditor as RREditor<unknown>,
  SRV: srvEditor as RREditor<unknown>,
  CAA: caaEditor as RREditor<unknown>,
  URI: uriEditor as RREditor<unknown>,
  NAPTR: naptrEditor as RREditor<unknown>,
  SSHFP: sshfpEditor as RREditor<unknown>,
  TLSA: tlsaEditor as RREditor<unknown>,
  SMIMEA: smimeaEditor as RREditor<unknown>,
  DS: dsEditor as RREditor<unknown>,
  TXT: txtEditor as RREditor<unknown>,
  SVCB: svcbEditor as RREditor<unknown>,
  HTTPS: httpsEditor as RREditor<unknown>,
};

export function getRREditor(type: string): RREditor<unknown> | null {
  return REGISTRY[type.toUpperCase()] ?? null;
}

export interface RRContentFieldProps {
  type: string;
  value: string;
  onChange: (next: string) => void;
  /** Placeholder + className applied to the fallback single input. */
  fallbackPlaceholder?: string;
  /** Whether to autofocus the first input on mount (mirrors prior behavior). */
  autoFocus?: boolean;
}

/**
 * Routes value editing through the registered structured editor for `type`,
 * falling back to a plain text input when none is registered, and to a raw
 * editable textarea + warning banner when the existing wire content
 * doesn't parse cleanly.
 *
 * The parent stays the source of truth for the wire-format string. The
 * orchestrator's only state is the sticky "raw mode" flag (kept in
 * `useState`) so a momentarily-valid edit during raw recovery doesn't
 * swap the textarea out from under the operator. Remount-on-type-change
 * via `key={type}` from the parent resets the flag for a new record.
 */
export function RRContentField(props: RRContentFieldProps): ReactElement {
  const editor = getRREditor(props.type);

  // Untyped fallback: render a plain input identical in shape to what the
  // editor used before per-type structured editors existed.
  if (!editor) {
    return (
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.fallbackPlaceholder}
        className={`${inputClass} font-mono`}
        spellCheck={false}
        autoFocus={props.autoFocus}
      />
    );
  }

  return <StructuredField editor={editor} {...props} />;
}

function StructuredField({
  editor,
  value,
  onChange,
}: {
  editor: RREditor<unknown>;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  // Sticky "raw" mode: once we drop into raw on mount because the value
  // didn't parse, stay there for the rest of this dialog session.
  const [stickyRaw] = useState(() => value !== "" && editor.parse(value) === null);

  // Memoize parse() and serialize() against `value`. Parent renders fire on
  // every keystroke in OTHER fields (name, TTL, comment) - without memo
  // we'd re-parse and re-serialize the value field on each one, which adds
  // up for SVCB/NAPTR/TXT inputs whose parse path runs a regex or walks
  // every code-point. With memo, this work only repeats when `value`
  // actually changes.
  const struct = useMemo(
    () => (value === "" ? editor.empty() : (editor.parse(value) ?? editor.empty())),
    [editor, value],
  );
  const wire = useMemo(() => editor.serialize(struct), [editor, struct]);

  // Stable structured-onChange so the per-type Editor's input handlers
  // don't see a new closure every render.
  const handleStructChange = useCallback(
    (next: unknown) => onChange(editor.serialize(next as never)),
    [editor, onChange],
  );

  if (stickyRaw) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs">
          <strong>Raw mode:</strong> this record doesn&apos;t match the expected{" "}
          <code>{editor.type}</code> wire format. Editing the wire-format text directly. Fix the
          structure and save to bring it back in line with the RFC.
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={`${inputClass} font-mono`}
          spellCheck={false}
        />
      </div>
    );
  }

  const Editor = editor.Editor;

  return (
    <div className="space-y-3">
      <Editor value={struct} onChange={handleStructChange} />
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
        <div className="text-[10px] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Wire format sent to PDNS
        </div>
        <code className="block font-mono text-xs break-all">{wire}</code>
      </div>
    </div>
  );
}
