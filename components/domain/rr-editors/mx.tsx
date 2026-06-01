/**
 * components/domain/rr-editors/mx.tsx
 *
 * MX = preference (uint16) + exchange (hostname). RFC 1035 § 3.3.9.
 * RFC 7505 null MX is `0 .` - handled by the validator on save; the
 * editor lets you type `.` literally if you need it.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";

export interface MxStruct {
  preference: number;
  exchange: string;
}

export const mxEditor: RREditor<MxStruct> = {
  type: "MX",
  empty: () => ({ preference: 10, exchange: "" }),
  serialize: (s) => `${s.preference} ${s.exchange.trim()}`.trim(),
  parse(wire) {
    const parts = wire.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const [prefStr, exchange] = parts as [string, string];
    if (!/^\d+$/.test(prefStr)) return null;
    const preference = Number(prefStr);
    if (preference < 0 || preference > 65535) return null;
    return { preference, exchange };
  },
  Editor({ value, onChange }) {
    return (
      <div className="grid grid-cols-[7rem_1fr] gap-3">
        <Field label="Preference" hint="0–65535. Lower wins.">
          {uintInput(value.preference, 65535, (n) => onChange({ ...value, preference: n }))}
        </Field>
        <Field label="Exchange" hint="Hostname of the mail server (trailing dot recommended).">
          <input
            value={value.exchange}
            onChange={(e) => onChange({ ...value, exchange: e.target.value })}
            placeholder="mail.example.com."
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
