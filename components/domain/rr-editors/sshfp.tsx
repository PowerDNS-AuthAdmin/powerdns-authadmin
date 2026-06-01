/**
 * components/domain/rr-editors/sshfp.tsx
 *
 * SSHFP = algorithm fpType hex-fingerprint. RFC 4255 + IANA SSHFP registry.
 */

"use client";

import type { RREditor } from "./types";
import { Field, inputClass } from "./_form";
import { SelectMenu } from "@/components/ui/select-menu";

export interface SshfpStruct {
  algorithm: number;
  fpType: number;
  fingerprint: string;
}

const ALGORITHMS: Array<{ value: number; label: string }> = [
  { value: 1, label: "1 - RSA" },
  { value: 2, label: "2 - DSA" },
  { value: 3, label: "3 - ECDSA" },
  { value: 4, label: "4 - Ed25519" },
  { value: 6, label: "6 - Ed448" },
];

const FP_TYPES: Array<{ value: number; label: string }> = [
  { value: 1, label: "1 - SHA-1" },
  { value: 2, label: "2 - SHA-256" },
];

export const sshfpEditor: RREditor<SshfpStruct> = {
  type: "SSHFP",
  empty: () => ({ algorithm: 4, fpType: 2, fingerprint: "" }),
  serialize: (s) => `${s.algorithm} ${s.fpType} ${s.fingerprint.replace(/\s+/g, "").toLowerCase()}`,
  parse(wire) {
    const m = /^(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s*$/.exec(wire.trim());
    if (!m) return null;
    return {
      algorithm: Number(m[1]),
      fpType: Number(m[2]),
      fingerprint: (m[3] ?? "").toLowerCase(),
    };
  },
  Editor({ value, onChange }) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Algorithm">
            <SelectMenu
              value={String(value.algorithm)}
              onChange={(v) => onChange({ ...value, algorithm: Number(v) })}
              options={ALGORITHMS.map((a) => ({ value: String(a.value), label: a.label }))}
              ariaLabel="Algorithm"
              className="w-full"
            />
          </Field>
          <Field label="Fingerprint type">
            <SelectMenu
              value={String(value.fpType)}
              onChange={(v) => onChange({ ...value, fpType: Number(v) })}
              options={FP_TYPES.map((f) => ({ value: String(f.value), label: f.label }))}
              ariaLabel="Fingerprint type"
              className="w-full"
            />
          </Field>
        </div>
        <Field label="Fingerprint" hint="Hex; whitespace is stripped on save.">
          <input
            value={value.fingerprint}
            onChange={(e) => onChange({ ...value, fingerprint: e.target.value })}
            placeholder="0a1b2c3d…"
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
