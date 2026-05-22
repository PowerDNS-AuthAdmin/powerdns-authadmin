/**
 * components/domain/rr-editors/tlsa.tsx
 *
 * TLSA = usage selector matchingType cert-data. RFC 6698.
 * SMIMEA shares the wire shape (RFC 8162); the SMIMEA editor delegates here.
 */

"use client";

import type { RREditor } from "./types";
import { Field, inputClass } from "./_form";

export interface TlsaStruct {
  usage: number;
  selector: number;
  matchingType: number;
  certData: string;
}

const USAGE: Array<{ value: number; label: string }> = [
  { value: 0, label: "0 — PKIX-TA" },
  { value: 1, label: "1 — PKIX-EE" },
  { value: 2, label: "2 — DANE-TA" },
  { value: 3, label: "3 — DANE-EE" },
];
const SELECTOR: Array<{ value: number; label: string }> = [
  { value: 0, label: "0 — Full certificate" },
  { value: 1, label: "1 — SubjectPublicKeyInfo" },
];
const MATCHING: Array<{ value: number; label: string }> = [
  { value: 0, label: "0 — Exact" },
  { value: 1, label: "1 — SHA-256" },
  { value: 2, label: "2 — SHA-512" },
];

function tlsaImpl(type: "TLSA" | "SMIMEA"): RREditor<TlsaStruct> {
  return {
    type,
    empty: () => ({ usage: 3, selector: 1, matchingType: 1, certData: "" }),
    serialize: (s) =>
      `${s.usage} ${s.selector} ${s.matchingType} ${s.certData.replace(/\s+/g, "").toLowerCase()}`,
    parse(wire) {
      const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s*$/.exec(wire.trim());
      if (!m) return null;
      return {
        usage: Number(m[1]),
        selector: Number(m[2]),
        matchingType: Number(m[3]),
        certData: (m[4] ?? "").toLowerCase(),
      };
    },
    Editor({ value, onChange }) {
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Usage">
              <select
                value={value.usage}
                onChange={(e) => onChange({ ...value, usage: Number(e.target.value) })}
                className={inputClass}
              >
                {USAGE.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Selector">
              <select
                value={value.selector}
                onChange={(e) => onChange({ ...value, selector: Number(e.target.value) })}
                className={inputClass}
              >
                {SELECTOR.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Matching type">
              <select
                value={value.matchingType}
                onChange={(e) => onChange({ ...value, matchingType: Number(e.target.value) })}
                className={inputClass}
              >
                {MATCHING.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Certificate association data" hint="Hex.">
            <input
              value={value.certData}
              onChange={(e) => onChange({ ...value, certData: e.target.value })}
              className={`${inputClass} font-mono`}
              spellCheck={false}
            />
          </Field>
        </div>
      );
    },
  };
}

export const tlsaEditor = tlsaImpl("TLSA");
export const smimeaEditor = tlsaImpl("SMIMEA");
