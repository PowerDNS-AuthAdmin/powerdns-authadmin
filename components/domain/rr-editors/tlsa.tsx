/**
 * components/domain/rr-editors/tlsa.tsx
 *
 * TLSA = usage selector matchingType cert-data. RFC 6698.
 * SMIMEA shares the wire shape (RFC 8162); the SMIMEA editor delegates here.
 */

"use client";

import type { RREditor } from "./types";
import { Field, inputClass } from "./_form";
import { SelectMenu } from "@/components/ui/select-menu";

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
              <SelectMenu
                value={String(value.usage)}
                onChange={(v) => onChange({ ...value, usage: Number(v) })}
                options={USAGE.map((u) => ({ value: String(u.value), label: u.label }))}
                ariaLabel="Usage"
                className="w-full"
              />
            </Field>
            <Field label="Selector">
              <SelectMenu
                value={String(value.selector)}
                onChange={(v) => onChange({ ...value, selector: Number(v) })}
                options={SELECTOR.map((s) => ({ value: String(s.value), label: s.label }))}
                ariaLabel="Selector"
                className="w-full"
              />
            </Field>
            <Field label="Matching type">
              <SelectMenu
                value={String(value.matchingType)}
                onChange={(v) => onChange({ ...value, matchingType: Number(v) })}
                options={MATCHING.map((m) => ({ value: String(m.value), label: m.label }))}
                ariaLabel="Matching type"
                className="w-full"
              />
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
