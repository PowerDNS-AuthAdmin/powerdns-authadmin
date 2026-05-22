/**
 * components/domain/rr-editors/uri.tsx
 *
 * URI = priority weight "target". RFC 7553. Target is always quoted.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";

export interface UriStruct {
  priority: number;
  weight: number;
  target: string;
}

export const uriEditor: RREditor<UriStruct> = {
  type: "URI",
  empty: () => ({ priority: 10, weight: 0, target: "" }),
  serialize(s) {
    const escaped = s.target.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${s.priority} ${s.weight} "${escaped}"`;
  },
  parse(wire) {
    const m = /^(\d+)\s+(\d+)\s+"((?:\\"|[^"])*)"\s*$/.exec(wire.trim());
    if (!m) return null;
    const priority = Number(m[1]);
    const weight = Number(m[2]);
    if (priority > 65535 || weight > 65535) return null;
    return {
      priority,
      weight,
      target: (m[3] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
    };
  },
  Editor({ value, onChange }) {
    return (
      <div className="grid grid-cols-[6rem_6rem_1fr] gap-3">
        <Field label="Priority">
          {uintInput(value.priority, 65535, (n) => onChange({ ...value, priority: n }))}
        </Field>
        <Field label="Weight">
          {uintInput(value.weight, 65535, (n) => onChange({ ...value, weight: n }))}
        </Field>
        <Field label="Target" hint="The URI; auto-quoted on save.">
          <input
            value={value.target}
            onChange={(e) => onChange({ ...value, target: e.target.value })}
            placeholder="https://example.com/path"
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
