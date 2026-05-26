/**
 * app/api/admin/pdns/zones/[zoneId]/rrsets/route.ts
 *
 * PATCH — apply one or more RRset changes to a zone.
 *
 * Flow:
 *   1. Permission check (record.* — discriminated per change kind).
 *   2. Resolve the backend (by `serverSlug` in the body).
 *   3. Fetch the zone via PdnsClient (current RRsets for the audit snapshot).
 *   4. Build a single PATCH body that bundles every change:
 *        - "upsert" → REPLACE
 *        - "delete" → DELETE
 *      EXTEND/PRUNE optimization (when supported) lands later this to
 *      shrink the concurrent-edit race window further.
 *   5. Send the PATCH; on success, write one audit row per change with
 *      before/after RRset snapshots.
 *   6. NOTIFY secondaries when the zone is Master/Primary (best-effort).
 *
 * Concurrency: per-RRset optimistic locking (ADR 0010). When a change
 * carries `expected: { hash }`, the server compares the live PDNS
 * rrset's structural hash and returns 409 if they differ. Old clients
 * that don't send `expected` fall back to last-write-wins. The
 * zone-level edited_serial check that lived here previously was
 * removed for the wrong-granularity reason captured in-line below.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { newSystemRequestId, withRequestId } from "@/lib/request-context";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { assertEditableZoneKind } from "@/lib/pdns/writable-kind";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { normalizeZoneId } from "@/lib/pdns/client";
import { deleteRRset, replaceRRset, zonePatchBody, type RRsetPatch } from "@/lib/pdns/rrsets";
import { detectRRsetConflicts } from "@/lib/pdns/rrset-hash";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { patchRRsetsSchema } from "@/lib/validators/rrsets";

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

/**
 * Drop duplicate-content records from an RRset. PowerDNS rejects an RRset that
 * carries the same content twice ("Duplicate record in RRset …"), which happens
 * naturally when an operator edits one record to a value another record in the
 * same RRset already holds. Deduping makes that edit MERGE — the same net result
 * the Review-changes diff already shows — instead of failing on apply. First
 * occurrence wins (preserves order); a present `disabled:false` beats a later
 * disabled duplicate so a merge doesn't silently disable the record.
 */
function dedupeRecordsByContent<T extends { content: string; disabled?: boolean }>(
  records: readonly T[],
): T[] {
  const byContent = new Map<string, T>();
  for (const r of records) {
    const existing = byContent.get(r.content);
    if (!existing) byContent.set(r.content, r);
    else if (existing.disabled && !r.disabled) byContent.set(r.content, r);
  }
  return [...byContent.values()];
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);
    const { zoneId: zoneParam } = await context.params;
    const zoneName = normalizeZoneId(decodeURIComponent(zoneParam));

    let input;
    try {
      input = patchRRsetsSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const server = input.serverSlug
      ? await findPdnsServerBySlug(input.serverSlug)
      : await findDefaultPdnsServer();
    if (server?.disabledAt !== null) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    // Permission check, per-change. Each action passes if EITHER:
    //   - the user holds the permission at GLOBAL scope via a role
    //     assignment (`globalPermissions.has("record.<perm>")`), OR
    //   - the user holds a zone_grant for THIS (server, zone) that
    //     includes the permission (`hasZonePermissionViaGrant`).
    //
    // We require:
    //   - record.update OR record.create for upsert (whichever the
    //     user has; since we can't know without the current state we
    //     accept either),
    //   - record.delete for delete.
    const hasRecordPerm = (perm: "create" | "update" | "delete"): boolean =>
      canActOnZone({
        hasGlobalPermission: globalPermissions.has(`record.${perm}`),
        grants: zoneGrants,
        serverId: server.id,
        zoneName,
        permission: `record.${perm}`,
      });
    const needsCreateOrUpdate = input.changes.some((c) => c.kind === "upsert");
    const needsDelete = input.changes.some((c) => c.kind === "delete");
    if (needsCreateOrUpdate && !hasRecordPerm("create") && !hasRecordPerm("update")) {
      throw new ForbiddenError("Missing record.create or record.update.");
    }
    if (needsDelete && !hasRecordPerm("delete")) {
      throw new ForbiddenError("Missing record.delete.");
    }

    const client = getBackendGateway(server);
    let zoneBefore;
    try {
      zoneBefore = await client.getZone(zoneName);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError(`Zone "${zoneName}" not found on backend.`);
      }
      if (err instanceof PdnsError) {
        throw new ValidationError(`PDNS: ${redact(err.message)}`);
      }
      throw err;
    }

    // Read-only-by-kind: a Slave/Secondary/Consumer zone's records are owned by
    // its primary over AXFR, so reject content edits regardless of the backend's
    // role (a primary box can still host mirror zones).
    assertEditableZoneKind(zoneBefore.kind);

    // NOTE: zone-level edited_serial concurrency check was removed — it had
    // the wrong granularity (every successful edit advances the zone's serial
    // so consecutive edits in the same session falsely 409'd against the
    // user's own prior write, since router.refresh() is async and the page's
    // snapshot is stale until it propagates). Per-RRset locking (client sends
    // the original RRset content; server only 409s if THIS rrset was actually
    // modified by someone else) is the correct long-term fix and is queued
    // forUntil then we let conflicts fall back to last-write-wins
    // — the audit log captures every change for post-hoc reconciliation.

    const beforeMap = new Map((zoneBefore.rrsets ?? []).map((rr) => [`${rr.name}|${rr.type}`, rr]));

    // ADR 0010: per-RRset optimistic concurrency check. Pure helper
    // `detectRRsetConflicts` walks the changes, computes structural
    // hashes against the just-fetched zoneBefore (no extra PDNS
    // round-trip), and returns per-change conflicts. Any conflict in
    // the batch blocks ALL changes (transactional all-or-nothing —
    // a partial apply would leave the zone in a state the operator
    // didn't intend). Old clients that don't send `expected` fall
    // through unchanged (last-write-wins).
    const conflicts = detectRRsetConflicts(
      input.changes.map((c) => ({
        name: normalizeName(c.name, zoneName),
        type: c.type,
        ...(c.expected ? { expected: c.expected } : {}),
      })),
      beforeMap,
    );
    if (conflicts.length > 0) {
      logger.info(
        {
          server: server.slug,
          zone: zoneName,
          userId: user.id,
          conflicts: conflicts.length,
        },
        "rrsets.patch.conflict",
      );
      return Response.json({ error: "conflict", conflicts }, { status: 409 });
    }

    // Build patches + collect per-change audit pairs.
    const patches: RRsetPatch[] = [];
    interface AuditPair {
      kind: "upsert" | "delete";
      key: string;
      name: string;
      type: string;
      before: unknown;
      after: unknown;
    }
    const auditPairs: AuditPair[] = [];

    for (const change of input.changes) {
      const name = normalizeName(change.name, zoneName);
      const type = change.type;
      const key = `${name}|${type}`;
      const before = beforeMap.get(key) ?? null;
      // Always carry comments through the PATCH. If the operator
      // edited the comment, `change.comment` is a string (possibly
      // empty — meaning "clear"); otherwise we keep whatever PDNS
      // already has so the round-trip doesn't wipe operator notes.
      const liveComments = readComments(before);
      const outgoingComments =
        change.kind === "upsert" && change.comment !== undefined
          ? buildCommentList(change.comment, user.email)
          : liveComments;

      if (change.kind === "upsert") {
        // Merge duplicate content so editing a record to a sibling's value
        // doesn't trip PDNS' "Duplicate record in RRset" rejection.
        const records = dedupeRecordsByContent(change.records);
        patches.push(
          replaceRRset({
            name,
            type,
            ttl: change.ttl,
            records,
            comments: outgoingComments,
          }),
        );
        auditPairs.push({
          kind: "upsert",
          key,
          name,
          type,
          before: before ? normalizeRRsetForAudit(before) : null,
          after: {
            name,
            type,
            ttl: change.ttl,
            records,
            comments: outgoingComments,
          },
        });
      } else {
        patches.push(deleteRRset(name, type));
        auditPairs.push({
          kind: "delete",
          key,
          name,
          type,
          before: before ? normalizeRRsetForAudit(before) : null,
          after: null,
        });
      }
    }

    try {
      await client.patchZone(zoneName, zonePatchBody(...patches));
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError("Zone not found on backend.");
      }
      if (err instanceof PdnsError) {
        // Surface PDNS's validation message; the editor renders it.
        throw new ValidationError(redact(err.message));
      }
      throw err;
    }

    // Fan out + kick the poller the instant PDNS confirms. Doing this
    // BEFORE audit + NOTIFY shaves ~200-400ms off the user-perceived
    // latency: the browser's SSE listener fires router.refresh while
    // the server is still finishing the bookkeeping work.
    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: server.slug,
      actor: user.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    const hdrs = await headers();
    const reqInfo = getRequestContext(hdrs);

    // Audit inserts run in parallel — one DB round-trip's worth of
    // latency total, not N × round-trip. The PDNS edit has ALREADY been
    // applied at this point, so a failed audit write must NOT fail the
    // request (that would 500 an edit that succeeded on the backend,
    // misleading the operator into retrying an already-applied change).
    // Use allSettled and log any rejections at warn level instead.
    const auditResults = await Promise.allSettled(
      auditPairs.map((pair) =>
        appendAudit({
          actor: { type: "user", id: user.id },
          action:
            pair.kind === "delete"
              ? "record.delete"
              : pair.before === null
                ? "record.create"
                : "record.update",
          resource: {
            type: "rrset",
            id: `${server.slug}:${zoneName}:${pair.name}|${pair.type}`,
          },
          before: pair.before,
          after: pair.after,
          request: reqInfo,
        }),
      ),
    );
    auditResults.forEach((result, i) => {
      if (result.status === "rejected") {
        const pair = auditPairs[i];
        logger.warn(
          {
            server: server.slug,
            zone: zoneName,
            userId: user.id,
            rrset: pair ? `${pair.name}|${pair.type}` : undefined,
            error: result.reason instanceof Error ? result.reason.message : "unknown",
          },
          "rrsets.patch.audit.failed",
        );
      }
    });

    logger.info(
      {
        server: server.slug,
        zone: zoneName,
        userId: user.id,
        changes: input.changes.length,
      },
      "rrsets.patch.ok",
    );

    // Auto-NOTIFY Master/Primary zones — pushed to background so the
    // response returns the moment audits are flushed. The NOTIFY call
    // itself is async telemetry; the operator doesn't need to wait for
    // PDNS to acknowledge it.
    //
    // The background runs inside its own request-context frame with a fresh
    // id so the NOTIFY's PDNS calls + the zone.notify audit row are tagged
    // to a DISTINCT operation rather than leaking the parent rrset PATCH's
    // X-Request-Id (which would otherwise attribute every async background
    // call from this handler to one request id at confusingly varying times).
    if (zoneBefore.kind === "Master" || zoneBefore.kind === "Primary") {
      const notifyRequestId = newSystemRequestId();
      void withRequestId(notifyRequestId, async () => {
        let notified = false;
        let notifyError: string | null = null;
        try {
          await client.notifyZone(zoneName);
          notified = true;
        } catch (err) {
          notifyError = err instanceof Error ? redact(err.message) : "unknown";
          logger.warn(
            { server: server.slug, zone: zoneName, error: notifyError },
            "rrsets.patch.notify.failed",
          );
        }
        try {
          await appendAudit({
            actor: { type: "user", id: user.id },
            action: "zone.notify",
            resource: { type: "zone", id: `${server.slug}:${zoneName}` },
            after: { kind: zoneBefore.kind, success: notified, error: notifyError },
            // Use the fresh background id (matches the PDNS NOTIFY call's id)
            // so the operator can pivot from the audit row to its PDNS log.
            request: { ...reqInfo, requestId: notifyRequestId },
          });
        } catch {
          // audit row best-effort; the NOTIFY already happened
        }
      });
    }

    return Response.json({
      ok: true,
      applied: input.changes.length,
    });
  } catch (err) {
    return errorResponse(err, "rrsets.patch.error");
  }
}

/**
 * Normalize a user-typed RRset name. Accepts:
 *   - "@" → zone apex
 *   - relative ("www") → www.zone.
 *   - fully-qualified ("www.example.com.") → as-is
 */
/**
 * Pull a comments array off a PDNS rrset snapshot. PDNS returns the
 * field as an array of `{ content, account, modified_at }` objects, but
 * older / proxied responses may omit it. We don't reshape the entries —
 * we forward whatever PDNS gave us so the PATCH round-trip preserves
 * them byte-for-byte.
 */
/**
 * Map the editor's plain-string comment into PDNS' wire shape. Empty
 * string clears the rrset's comments (returns `[]`). Otherwise one
 * comment with the actor's email as `account` and now as `modified_at`.
 * `modified_at` is epoch seconds per the PDNS API.
 */
function buildCommentList(
  text: string,
  accountEmail: string | null | undefined,
): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return [
    {
      content: trimmed,
      account: accountEmail ?? "",
      modified_at: Math.floor(Date.now() / 1000),
    },
  ];
}

function readComments(rrset: unknown): Array<Record<string, unknown>> {
  if (!rrset || typeof rrset !== "object") return [];
  const raw = (rrset as { comments?: unknown }).comments;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
}

/**
 * Normalize a PDNS rrset shape for the audit `before` snapshot — always
 * including `comments: []` when PDNS didn't supply the field, so the
 * before/after diff doesn't show a spurious "comments removed" line.
 */
function normalizeRRsetForAudit(rrset: unknown): Record<string, unknown> {
  if (!rrset || typeof rrset !== "object") return { comments: [] };
  const r = rrset as Record<string, unknown>;
  return { ...r, comments: readComments(rrset) };
}

function normalizeName(raw: string, zoneName: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zoneName;
  if (trimmed.endsWith(".")) return trimmed;
  return `${trimmed}.${zoneName}`;
}
