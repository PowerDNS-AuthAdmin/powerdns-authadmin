/**
 * lib/audit/log.ts
 *
 * The audit-log writer. Every state-changing path calls `appendAudit()`. If
 * a code path mutates the DB but doesn't write an audit entry, that's a bug
 * — reviewers check for this explicitly.
 *
 * Pattern:
 *
 *   await appendAudit({
 *     actor: { type: "user", id: user.id },
 *     action: "zone.create",
 *     resource: { type: "zone", id: zone.id },
 *     before: null,
 *     after: zone,
 *     request: { ip, userAgent, requestId },
 *   });
 *
 * Before/after JSON is redacted by `redactSnapshot()` below to strip known-
 * secret field names. The Pino logger does the same in-flight; the audit
 * table is the at-rest defense.
 */

import "server-only";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { publishAuditEvent } from "@/lib/realtime/event-bus";
import type { AuditAction } from "./actions";

// The redactor lives in its own DB-free module so unit tests can
// exercise it without dragging in `pg`. Re-exported here so existing
// callers (e.g. zone change-log viewer) keep working.
export { redactSnapshot } from "./redact";
import { redactSnapshot } from "./redact";

export interface AppendAuditInput {
  actor: {
    type: "user" | "token" | "system";
    id: string | null;
  };
  action: AuditAction;
  resource: {
    type: string;
    id: string | null;
  };
  before?: unknown;
  after?: unknown;
  request?: {
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  };
}

/**
 * Insert one audit log entry. Synchronous for ordering — the row is in the
 * same DB as the mutated table, so we get transactional consistency by
 * running both inside a single Drizzle transaction at the call site.
 *
 * @example
 *   await db.transaction(async (tx) => {
 *     const u = await tx.update(users).set(...).returning();
 *     await appendAudit({ ... }, tx);
 *   });
 */
export async function appendAudit(
  input: AppendAuditInput,
  // Optional Drizzle transaction handle — passed through when the call site
  // wraps in a transaction. Falls back to the module-level `db`.
  tx: typeof db = db,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: input.action,
    resourceType: input.resource.type,
    resourceId: input.resource.id,
    before: input.before === undefined ? null : redactSnapshot(input.before),
    after: input.after === undefined ? null : redactSnapshot(input.after),
    ip: input.request?.ip ?? null,
    userAgent: input.request?.userAgent ?? null,
    requestId: input.request?.requestId ?? null,
  });
  // Fan out for live-update subscribers (audit page, AdminAuditPanel).
  // Best-effort; failures are swallowed by the bus.
  publishAuditEvent({
    type: "audit.appended",
    action: input.action,
    resourceType: input.resource.type,
    resourceId: input.resource.id ?? null,
    actorId: input.actor.id ?? null,
    at: new Date().toISOString(),
  });
}
