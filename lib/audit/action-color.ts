/**
 * lib/audit/action-color.ts
 *
 * Pure helper mapping an audit action string to a Tailwind className
 * tinted by intent (create=green, delete=red, update/set=blue, other=
 * muted gray). Used by every audit-feed surface so chip colors stay
 * consistent — the zone change-log header chip (`<ActionChip>`) and the
 * admin-detail recent-activity panel (`<AdminAuditPanel>`).
 *
 * Suffix matching only — no per-action table. New actions get sensible
 * colors automatically as long as they end in one of the known verbs.
 * Anything else falls through to the muted variant, which is the right
 * default for opaque or operational events (e.g. `auth.login.success`).
 */

export function colorForAuditAction(action: string): string {
  if (action.endsWith(".create") || action.endsWith(".granted")) {
    return "bg-[color:var(--color-success)]/15 text-[color:var(--color-success)]";
  }
  if (action.endsWith(".delete") || action.endsWith(".revoked")) {
    return "bg-[color:var(--color-error)]/15 text-[color:var(--color-error)]";
  }
  if (action.endsWith(".update") || action.endsWith(".set")) {
    return "bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]";
  }
  return "bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg-muted)]";
}
