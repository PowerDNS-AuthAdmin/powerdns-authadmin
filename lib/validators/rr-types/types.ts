/**
 * lib/validators/rr-types/types.ts
 *
 * Shared types for the per-RR-type content validators. Each supported type
 * gets a `RRTypeValidator` implementation that turns a free-text content
 * string into a list of issues (errors that the spec forbids, warnings for
 * RFC-allowed-but-questionable choices) and an optional normalized form.
 *
 * Overrides: the editor UI shows errors → blocks save by default, but a
 * "save anyway" toggle downgrades errors to warnings. The audit log records
 * which records were saved with override active so an operator can later
 * trace policy bypasses.
 */

export type RRIssueLevel = "error" | "warning";

export interface RRValidationIssue {
  level: RRIssueLevel;
  message: string;
  /** Optional pointer at the offending substring (start, end) for highlight. */
  range?: { start: number; end: number };
}

export interface RRValidationResult {
  issues: RRValidationIssue[];
  /**
   * Normalized form of the input. May differ from the input even when there
   * are no issues — e.g. CNAME content gets a trailing dot added and the
   * label is lowercased. Always defined when `errors` is empty; may be the
   * raw input when validation failed.
   */
  normalized: string;
}

export interface RRTypeValidator {
  /** Uppercase RR type as PDNS expects it (`A`, `MX`, `TXT`, …). */
  type: string;
  /** Human label shown next to the input field. */
  label: string;
  /** One-sentence explanation rendered as form hint. */
  description: string;
  /** Placeholder text inside the empty input. */
  placeholder: string;
  /** Cite the RFC the validator enforces; surfaced in dev tooltips. */
  rfc: string;
  /** Run validation against a single content string. */
  validate(content: string): RRValidationResult;
}

/**
 * Convenience: did any error issue fire?
 */
export function hasErrors(result: RRValidationResult): boolean {
  return result.issues.some((i) => i.level === "error");
}

/**
 * Convenience: did any warning fire (errors-or-warnings could trigger an
 * override prompt in the UI).
 */
export function hasIssues(result: RRValidationResult): boolean {
  return result.issues.length > 0;
}
