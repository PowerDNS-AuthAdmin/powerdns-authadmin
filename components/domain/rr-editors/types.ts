/**
 * components/domain/rr-editors/types.ts
 *
 * Shared types for per-RR-type structured editors. Each registered editor
 * pairs:
 *
 *   - a `Struct` shape (the per-RR-type fields the UI exposes: e.g. MX
 *     splits to `{ preference, exchange }` instead of one wire-format
 *     string),
 *   - `parse(wire)` to round-trip an existing record's content back into
 *     that shape, returning `null` if the input is malformed (legacy /
 *     non-conformant — the orchestrator falls back to raw editing),
 *   - `serialize(struct)` that builds the canonical wire-format string
 *     PDNS expects,
 *   - `empty()` for a fresh record,
 *   - `Editor` — the React component that renders the structured inputs.
 *
 * Pure logic is JSON-safe and unit-testable; the React component is
 * presentation only.
 */

import type { ReactElement } from "react";

export interface RREditor<Struct> {
  /** Uppercase RR type as PDNS expects it. */
  type: string;
  /** Build the wire-format string PDNS will store. */
  serialize(struct: Struct): string;
  /** Best-effort parse of an existing record's wire content. */
  parse(wire: string): Struct | null;
  /** Initial value for a brand-new record. */
  empty(): Struct;
  /** Render the structured editor. */
  Editor: (props: { value: Struct; onChange: (next: Struct) => void }) => ReactElement;
}
