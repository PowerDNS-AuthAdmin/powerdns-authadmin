/**
 * components/domain/rr-editors/naptr.tsx
 *
 * NAPTR = order pref "flags" "service" "regexp" replacement. RFC 2915.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";

export interface NaptrStruct {
  order: number;
  preference: number;
  flags: string;
  service: string;
  regexp: string;
  replacement: string;
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function unq(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export const naptrEditor: RREditor<NaptrStruct> = {
  type: "NAPTR",
  empty: () => ({
    order: 100,
    preference: 10,
    flags: "",
    service: "",
    regexp: "",
    replacement: ".",
  }),
  serialize: (s) =>
    `${s.order} ${s.preference} ${q(s.flags)} ${q(s.service)} ${q(s.regexp)} ${s.replacement.trim() || "."}`,
  parse(wire) {
    // <order> <pref> "flags" "service" "regexp" <replacement>
    const re =
      /^(\d+)\s+(\d+)\s+"((?:\\"|[^"])*)"\s+"((?:\\"|[^"])*)"\s+"((?:\\"|[^"])*)"\s+(\S+)\s*$/;
    const m = re.exec(wire.trim());
    if (!m) return null;
    const order = Number(m[1]);
    const preference = Number(m[2]);
    if (order > 65535 || preference > 65535) return null;
    return {
      order,
      preference,
      flags: unq(m[3] ?? ""),
      service: unq(m[4] ?? ""),
      regexp: unq(m[5] ?? ""),
      replacement: m[6] ?? ".",
    };
  },
  Editor({ value, onChange }) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-[6rem_6rem_6rem_6rem] gap-3">
          <Field label="Order">
            {uintInput(value.order, 65535, (n) => onChange({ ...value, order: n }))}
          </Field>
          <Field label="Preference">
            {uintInput(value.preference, 65535, (n) => onChange({ ...value, preference: n }))}
          </Field>
          <Field label="Flags" hint='S, A, U, P — or "".'>
            <input
              value={value.flags}
              onChange={(e) => onChange({ ...value, flags: e.target.value })}
              maxLength={4}
              className={`${inputClass} font-mono uppercase`}
              spellCheck={false}
            />
          </Field>
          <Field label="Service" hint="e.g. SIP+D2T">
            <input
              value={value.service}
              onChange={(e) => onChange({ ...value, service: e.target.value })}
              className={`${inputClass} font-mono`}
              spellCheck={false}
            />
          </Field>
        </div>
        <Field label="Regexp" hint='Substitution expression, or "" if unused.'>
          <input
            value={value.regexp}
            onChange={(e) => onChange({ ...value, regexp: e.target.value })}
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
        <Field label="Replacement" hint='Target name, or "." if unused.'>
          <input
            value={value.replacement}
            onChange={(e) => onChange({ ...value, replacement: e.target.value })}
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
