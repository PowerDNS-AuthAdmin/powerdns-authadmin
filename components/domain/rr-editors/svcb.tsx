/**
 * components/domain/rr-editors/svcb.tsx
 *
 * SVCB / HTTPS = priority target [SvcParams]. RFC 9460.
 *
 * SvcParams editor: repeatable rows of (key dropdown / custom, value input).
 * The value input shape is driven by the key — comma-list for alpn/hints,
 * port for port, base64 for ech, no value for boolean params.
 *
 * HTTPS shares the wire format (RFC 9460 § 7); the HTTPS editor delegates.
 */

"use client";

import type { RREditor } from "./types";
import { Field, uintInput, inputClass } from "./_form";
import { SelectMenu } from "@/components/ui/select-menu";

type ParamShape = "comma-list" | "uint16" | "boolean" | "base64" | "string";

const KNOWN_KEYS: Array<{ key: string; shape: ParamShape; hint?: string }> = [
  { key: "alpn", shape: "comma-list", hint: "e.g. h2,h3" },
  { key: "no-default-alpn", shape: "boolean" },
  { key: "port", shape: "uint16" },
  { key: "ipv4hint", shape: "comma-list", hint: "e.g. 192.0.2.1,192.0.2.2" },
  { key: "ipv6hint", shape: "comma-list", hint: "e.g. 2001:db8::1" },
  { key: "ech", shape: "base64" },
  { key: "mandatory", shape: "comma-list", hint: "Required keys." },
  { key: "dohpath", shape: "string" },
];

function shapeFor(key: string): ParamShape {
  return KNOWN_KEYS.find((k) => k.key === key)?.shape ?? "string";
}

export interface SvcbParam {
  key: string;
  /** Value as the operator typed it; boolean params keep "". */
  value: string;
}

export interface SvcbStruct {
  priority: number;
  target: string;
  params: SvcbParam[];
}

function serializeParam(p: SvcbParam): string {
  const shape = shapeFor(p.key);
  if (shape === "boolean") return p.key;
  // RFC 9460 § 2.1: SvcParamValues are quoted only when they contain
  // whitespace (or a literal `"`). Comma is a value separator inside
  // comma-list values (alpn, ipv4hint, …) and stays unquoted.
  const needsQuote = /[\s"]/.test(p.value);
  // Escape `\` before `"` (RFC 9460 char-string rules): doing it the other way
  // doubles the backslash the quote pass just inserted, and an unescaped `\`
  // in the value would corrupt the serialized param.
  const escaped = p.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const v = needsQuote ? `"${escaped}"` : p.value;
  return `${p.key}=${v}`;
}

function parseParam(token: string): SvcbParam | null {
  const eq = token.indexOf("=");
  if (eq < 0) return { key: token, value: "" };
  const key = token.slice(0, eq);
  let raw = token.slice(eq + 1);
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    raw = raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return { key, value: raw };
}

/** Split a SVCB rdata tail on whitespace, respecting `"…"`. */
function splitTokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = "";
  let inQuotes = false;
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === '"' && (i === 0 || s.charAt(i - 1) !== "\\")) {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
    i++;
  }
  if (cur !== "") out.push(cur);
  return out;
}

function svcbImpl(type: "SVCB" | "HTTPS"): RREditor<SvcbStruct> {
  return {
    type,
    empty: () => ({ priority: 1, target: ".", params: [] }),
    serialize(s) {
      const head = `${s.priority} ${s.target.trim() || "."}`;
      const params = s.params
        .filter((p) => p.key.trim() !== "")
        .map(serializeParam)
        .join(" ");
      return params === "" ? head : `${head} ${params}`;
    },
    parse(wire) {
      const tokens = splitTokens(wire.trim());
      if (tokens.length < 2) return null;
      const prioStr = tokens[0]!;
      if (!/^\d+$/.test(prioStr)) return null;
      const priority = Number(prioStr);
      if (priority > 65535) return null;
      const target = tokens[1]!;
      const params: SvcbParam[] = [];
      for (let i = 2; i < tokens.length; i++) {
        const p = parseParam(tokens[i]!);
        if (!p) return null;
        params.push(p);
      }
      return { priority, target, params };
    },
    Editor({ value, onChange }) {
      const setParam = (idx: number, next: SvcbParam) => {
        const params = [...value.params];
        params[idx] = next;
        onChange({ ...value, params });
      };
      const removeParam = (idx: number) => {
        const params = value.params.filter((_, i) => i !== idx);
        onChange({ ...value, params });
      };
      const addParam = () =>
        onChange({ ...value, params: [...value.params, { key: "alpn", value: "" }] });

      return (
        <div className="space-y-3">
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <Field label="Priority" hint="0 = AliasMode, 1+ = ServiceMode.">
              {uintInput(value.priority, 65535, (n) => onChange({ ...value, priority: n }))}
            </Field>
            <Field label="Target" hint='Alias / service hostname; "." means "this name".'>
              <input
                value={value.target}
                onChange={(e) => onChange({ ...value, target: e.target.value })}
                placeholder="."
                className={`${inputClass} font-mono`}
                spellCheck={false}
              />
            </Field>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">Service parameters</span>
              <button
                type="button"
                onClick={addParam}
                className="text-xs text-[color:var(--color-accent)] hover:underline"
              >
                + Add parameter
              </button>
            </div>
            {value.params.length === 0 ? (
              <p className="text-xs text-[color:var(--color-fg-muted)]">
                None. AliasMode (priority 0) typically has none; ServiceMode usually has `alpn=`.
              </p>
            ) : null}
            <div className="space-y-2">
              {value.params.map((p, i) => {
                const known = KNOWN_KEYS.find((k) => k.key === p.key);
                const isKnown = !!known;
                const shape = shapeFor(p.key);
                return (
                  <div key={i} className="grid grid-cols-[10rem_1fr_auto] gap-2">
                    <div>
                      <SelectMenu
                        value={isKnown ? p.key : "__custom"}
                        onChange={(v) => {
                          if (v === "__custom") {
                            setParam(i, { key: "", value: "" });
                          } else {
                            setParam(i, { key: v, value: "" });
                          }
                        }}
                        options={[
                          ...KNOWN_KEYS.map((k) => ({ value: k.key, label: k.key })),
                          { value: "__custom", label: "Custom…" },
                        ]}
                        ariaLabel="Parameter key"
                        className="w-full"
                      />
                      {!isKnown ? (
                        <input
                          value={p.key}
                          onChange={(e) => setParam(i, { ...p, key: e.target.value })}
                          placeholder="key"
                          className={`${inputClass} mt-1 font-mono`}
                          spellCheck={false}
                        />
                      ) : null}
                    </div>
                    {shape === "boolean" ? (
                      <span className="self-center text-xs text-[color:var(--color-fg-muted)]">
                        (no value)
                      </span>
                    ) : shape === "uint16" ? (
                      uintInput(Number(p.value || 0), 65535, (n) =>
                        setParam(i, { ...p, value: String(n) }),
                      )
                    ) : (
                      <input
                        value={p.value}
                        onChange={(e) => setParam(i, { ...p, value: e.target.value })}
                        placeholder={known?.hint}
                        className={`${inputClass} mt-0 font-mono`}
                        spellCheck={false}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => removeParam(i)}
                      className="self-start rounded-md border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-subtle)]"
                      aria-label={`Remove ${p.key}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    },
  };
}

export const svcbEditor = svcbImpl("SVCB");
export const httpsEditor = svcbImpl("HTTPS");
