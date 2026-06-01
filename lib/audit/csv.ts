/**
 * lib/audit/csv.ts
 *
 * Pure RFC 4180 CSV serializer for audit rows. Lives separate from
 * the export route so the field-by-field escaping rules can be unit-
 * tested without dragging in the HTTP layer or the DB.
 *
 * Why hand-rolled instead of a dep: the format is two paragraphs of
 * the RFC and the rules are stable (quote when needed, double-up
 * internal quotes, never embed unescaped newlines). A dep here would
 * be all blast radius and zero leverage.
 */

import type { AuditEntry } from "@/lib/db/schema";

/**
 * Fixed column order. Matches the on-page table plus the
 * detail-only columns (`request_id`, `before`, `after`, `ip`,
 * `user_agent`). Order is part of the contract - downstream
 * consumers (Excel filters, jq pipelines) depend on it being
 * stable across exports.
 */
const COLUMNS = [
  "ts",
  "actor_type",
  "actor_id",
  "actor_email",
  "action",
  "resource_type",
  "resource_id",
  "ip",
  "user_agent",
  "request_id",
  "before",
  "after",
] as const;

/**
 * Row shape accepted by the serializer. Extends the raw audit row
 * with the joined `actorEmail` from `lib/db/repositories/audit.ts`
 * (`AuditEntryWithActor`). Kept structural so callers don't have
 * to import the repo type just for the CSV path.
 */
type CsvRow = AuditEntry & { actorEmail: string | null };

export function rowsToCsv(entries: readonly CsvRow[]): string {
  const lines: string[] = [COLUMNS.join(",")];
  for (const e of entries) {
    lines.push(
      [
        e.ts.toISOString(),
        e.actorType,
        e.actorId ?? "",
        e.actorEmail ?? "",
        e.action,
        e.resourceType,
        e.resourceId ?? "",
        e.ip ?? "",
        e.userAgent ?? "",
        e.requestId ?? "",
        e.before === null || e.before === undefined ? "" : JSON.stringify(e.before),
        e.after === null || e.after === undefined ? "" : JSON.stringify(e.after),
      ]
        .map(escapeField)
        .join(","),
    );
  }
  // CRLF terminator per RFC 4180. Trailing CRLF too so streamed
  // appends don't accidentally merge lines.
  return lines.join("\r\n") + "\r\n";
}

/**
 * Quote a field only when it contains a delimiter, quote, or
 * newline; doubling-up internal quotes. RFC 4180 §2 rules 5–7.
 *
 * Also neutralizes CSV/formula injection: a cell whose first character is
 * `=`, `+`, `-`, `@`, TAB, or CR is treated as a formula by Excel and
 * LibreOffice. Audit rows carry attacker-controlled values (User-Agent,
 * resource ids, actor email), so a `=HYPERLINK(...)`/`=cmd|...` payload in
 * a User-Agent would otherwise execute when an operator opens the export.
 * We defang it by prefixing a single quote, then apply RFC-4180 quoting.
 * See OWASP "CSV Injection".
 *
 * Exported only for the test file - most callers should go through
 * `rowsToCsv`.
 */
export function escapeField(value: string): string {
  if (value === "") return "";
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
