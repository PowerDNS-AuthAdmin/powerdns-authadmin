/**
 * components/domain/rr-editors/srv.tsx
 *
 * SRV = priority weight port target. RFC 2782.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";

export interface SrvStruct {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export const srvEditor: RREditor<SrvStruct> = {
  type: "SRV",
  empty: () => ({ priority: 10, weight: 0, port: 0, target: "" }),
  serialize: (s) => `${s.priority} ${s.weight} ${s.port} ${s.target.trim()}`.trim(),
  parse(wire) {
    const parts = wire.trim().split(/\s+/);
    if (parts.length !== 4) return null;
    const [p, w, port, target] = parts as [string, string, string, string];
    for (const n of [p, w, port]) if (!/^\d+$/.test(n)) return null;
    const priority = Number(p);
    const weight = Number(w);
    const portN = Number(port);
    if (priority > 65535 || weight > 65535 || portN > 65535) return null;
    return { priority, weight, port: portN, target };
  },
  Editor({ value, onChange }) {
    return (
      <div className="grid grid-cols-[6rem_6rem_6rem_1fr] gap-3">
        <Field label="Priority">
          {uintInput(value.priority, 65535, (n) => onChange({ ...value, priority: n }))}
        </Field>
        <Field label="Weight">
          {uintInput(value.weight, 65535, (n) => onChange({ ...value, weight: n }))}
        </Field>
        <Field label="Port">
          {uintInput(value.port, 65535, (n) => onChange({ ...value, port: n }))}
        </Field>
        <Field label="Target" hint="Hostname; trailing dot canonical.">
          <input
            value={value.target}
            onChange={(e) => onChange({ ...value, target: e.target.value })}
            placeholder="sip.example.com."
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
