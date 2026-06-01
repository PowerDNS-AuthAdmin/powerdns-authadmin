/**
 * components/domain/rr-editors/caa.tsx
 *
 * CAA = flags (uint8) tag value. RFC 8659.
 * Tag is one of a small registered set; we surface them as a select and
 * still allow free entry (the IANA registry can grow).
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";
import { SelectMenu } from "@/components/ui/select-menu";

export interface CaaStruct {
  flags: number;
  tag: string;
  value: string;
}

const KNOWN_TAGS = [
  "issue",
  "issuewild",
  "iodef",
  "contactemail",
  "contactphone",
  "tbs",
  "cansignhttpexchanges",
] as const;

export const caaEditor: RREditor<CaaStruct> = {
  type: "CAA",
  empty: () => ({ flags: 0, tag: "issue", value: "" }),
  serialize(s) {
    // Always double-quote the value half - that's the wire-format presentation.
    const escaped = s.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${s.flags} ${s.tag.trim()} "${escaped}"`;
  },
  parse(wire) {
    const trimmed = wire.trim();
    // Match: <digits> <tag> "value with optional escapes"
    const m = /^(\d+)\s+([A-Za-z][A-Za-z0-9-]*)\s+"((?:\\"|[^"])*)"\s*$/.exec(trimmed);
    if (!m) {
      // Allow unquoted value as a fallback for legacy entries.
      const m2 = /^(\d+)\s+([A-Za-z][A-Za-z0-9-]*)\s+(.+?)\s*$/.exec(trimmed);
      if (!m2) return null;
      const flags = Number(m2[1]);
      if (flags > 255) return null;
      return { flags, tag: m2[2]!, value: m2[3]! };
    }
    const flags = Number(m[1]);
    if (flags > 255) return null;
    const value = (m[3] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return { flags, tag: m[2]!, value };
  },
  Editor({ value, onChange }) {
    const tagIsKnown = (KNOWN_TAGS as readonly string[]).includes(value.tag);
    return (
      <div className="grid grid-cols-[6rem_10rem_1fr] gap-3">
        <Field label="Flags" hint="0 or 128 (critical).">
          {uintInput(value.flags, 255, (n) => onChange({ ...value, flags: n }))}
        </Field>
        <Field label="Tag">
          <SelectMenu
            value={tagIsKnown ? value.tag : "__custom"}
            onChange={(v) => {
              if (v === "__custom") return; // keep current
              onChange({ ...value, tag: v });
            }}
            options={[
              ...KNOWN_TAGS.map((t) => ({ value: t, label: t })),
              { value: "__custom", label: "Custom…" },
            ]}
            ariaLabel="Tag"
            className="w-full"
          />
          {!tagIsKnown ? (
            <input
              value={value.tag}
              onChange={(e) => onChange({ ...value, tag: e.target.value })}
              className={`${inputClass} mt-2 font-mono`}
              spellCheck={false}
            />
          ) : null}
        </Field>
        <Field label="Value" hint="Auto-quoted on save.">
          <input
            value={value.value}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            placeholder="letsencrypt.org"
            className={`${inputClass} font-mono`}
            spellCheck={false}
          />
        </Field>
      </div>
    );
  },
};
