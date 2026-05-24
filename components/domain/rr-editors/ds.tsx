/**
 * components/domain/rr-editors/ds.tsx
 *
 * DS = keyTag algorithm digestType digest. RFC 4034 § 5 + RFC 8624.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";
import { SelectMenu } from "@/components/ui/select-menu";

export interface DsStruct {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

const ALGORITHMS: Array<{ value: number; label: string }> = [
  { value: 8, label: "8 — RSA/SHA-256" },
  { value: 10, label: "10 — RSA/SHA-512" },
  { value: 13, label: "13 — ECDSA P-256/SHA-256" },
  { value: 14, label: "14 — ECDSA P-384/SHA-384" },
  { value: 15, label: "15 — Ed25519" },
  { value: 16, label: "16 — Ed448" },
];
const DIGEST_TYPES: Array<{ value: number; label: string }> = [
  { value: 1, label: "1 — SHA-1" },
  { value: 2, label: "2 — SHA-256" },
  { value: 4, label: "4 — SHA-384" },
];

export const dsEditor: RREditor<DsStruct> = {
  type: "DS",
  empty: () => ({ keyTag: 0, algorithm: 13, digestType: 2, digest: "" }),
  serialize: (s) =>
    `${s.keyTag} ${s.algorithm} ${s.digestType} ${s.digest.replace(/\s+/g, "").toLowerCase()}`,
  parse(wire) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s*$/.exec(wire.trim());
    if (!m) return null;
    const keyTag = Number(m[1]);
    if (keyTag > 65535) return null;
    return {
      keyTag,
      algorithm: Number(m[2]),
      digestType: Number(m[3]),
      digest: (m[4] ?? "").toLowerCase(),
    };
  },
  Editor({ value, onChange }) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Key tag" hint="0–65535.">
            {uintInput(value.keyTag, 65535, (n) => onChange({ ...value, keyTag: n }))}
          </Field>
          <Field label="Algorithm">
            <SelectMenu
              value={String(value.algorithm)}
              onChange={(v) => onChange({ ...value, algorithm: Number(v) })}
              options={ALGORITHMS.map((a) => ({ value: String(a.value), label: a.label }))}
              ariaLabel="Algorithm"
              className="w-full"
            />
          </Field>
          <Field label="Digest type">
            <SelectMenu
              value={String(value.digestType)}
              onChange={(v) => onChange({ ...value, digestType: Number(v) })}
              options={DIGEST_TYPES.map((d) => ({ value: String(d.value), label: d.label }))}
              ariaLabel="Digest type"
              className="w-full"
            />
          </Field>
        </div>
        <Field label="Digest" hint="Hex.">
          <input
            value={value.digest}
            onChange={(e) => onChange({ ...value, digest: e.target.value })}
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
