/**
 * components/domain/rr-editors/txt.tsx
 *
 * TXT — one or more <character-string>s, each capped at 255 octets
 * (RFC 1035 § 3.3.14). Operators type the value as a single unquoted
 * blob; on save we split the blob into ≤255-octet chunks, escape `\`
 * and `"`, and emit `"chunk1" "chunk2"` wire format.
 *
 * Parse: best-effort. Already-quoted input is unescaped + concatenated.
 * Bare input is returned as the blob unchanged.
 */

"use client";

import { extractQuotedStrings } from "@/lib/dns/txt";
import type { RREditor } from "./types";
import { Field, inputClass } from "./_form";

export interface TxtStruct {
  /** The unquoted, fully-concatenated payload. */
  blob: string;
}

/** Split a UTF-8 string into chunks ≤ 255 octets each, not splitting code points. */
function chunkByBytes(input: string, maxBytes = 255): string[] {
  const enc = new TextEncoder();
  if (enc.encode(input).byteLength <= maxBytes) return [input];
  const chunks: string[] = [];
  let buf = "";
  let used = 0;
  for (const ch of input) {
    // Iterating with `for…of` walks code points; we count their UTF-8 byte size.
    const w = enc.encode(ch).byteLength;
    if (used + w > maxBytes) {
      chunks.push(buf);
      buf = ch;
      used = w;
    } else {
      buf += ch;
      used += w;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

function txtEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const txtEditor: RREditor<TxtStruct> = {
  type: "TXT",
  empty: () => ({ blob: "" }),
  serialize(s) {
    if (s.blob === "") return '""';
    const chunks = chunkByBytes(s.blob, 255);
    return chunks.map((c) => `"${txtEscape(c)}"`).join(" ");
  },
  parse(wire) {
    const trimmed = wire.trim();
    if (trimmed === "") return { blob: "" };
    if (trimmed.startsWith('"')) {
      const strings = extractQuotedStrings(trimmed);
      if (!strings) return null;
      return { blob: strings.join("") };
    }
    // Bare unquoted text — accept as the blob unchanged so editing a
    // legacy non-quoted record doesn't lose its payload.
    return { blob: trimmed };
  },
  Editor({ value, onChange }) {
    const enc = new TextEncoder();
    const bytes = enc.encode(value.blob).byteLength;
    const chunks = Math.max(1, Math.ceil(bytes / 255));
    return (
      <Field
        label="Text"
        hint={`${bytes} octet${bytes === 1 ? "" : "s"}, will be split into ${chunks} character-string${chunks === 1 ? "" : "s"} on save.`}
      >
        <textarea
          value={value.blob}
          onChange={(e) => onChange({ blob: e.target.value })}
          rows={4}
          placeholder="v=spf1 ip4:192.0.2.0/24 -all"
          className={`${inputClass} font-mono`}
          spellCheck={false}
        />
      </Field>
    );
  },
};
