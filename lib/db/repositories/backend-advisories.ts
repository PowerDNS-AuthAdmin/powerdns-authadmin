/**
 * lib/db/repositories/backend-advisories.ts
 *
 * Persistence for the health bell (ADR-0015). The poller calls
 * `syncBackendAdvisories` each cycle with the freshly-evaluated set for a
 * backend; we upsert those (preserving `first_seen_at` + `acknowledged_at`) and
 * prune any that no longer apply, so the table self-heals.
 *
 * Debounce: an advisory only "rings the bell" once it's been observed on at
 * least two cycles - expressed as `last_seen_at > first_seen_at` (equal on the
 * first sighting, strictly greater afterwards). No time constant, no flapping
 * on a single failed poll. Both sides are columns, so the comparison is
 * SQL-level - no Date binds (the dialect trap from the statistics bug).
 */

import "server-only";
import { and, eq, gt, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backendAdvisories, pdnsServers } from "@/lib/db/schema";
import type { EvaluatedAdvisory } from "@/lib/health/evaluator";

/** A confirmed advisory's bell-visible fields, for change detection. */
const visibleSig = (r: {
  code: string;
  severity: string;
  detail: string;
  acknowledgedAt: Date | null;
}): string => `${r.code}|${r.severity}|${r.acknowledgedAt ? 1 : 0}|${r.detail}`;

/**
 * Upsert the evaluated advisories for one backend and prune the rest. Returns
 * whether the BELL-VISIBLE set changed (a confirmed advisory appeared,
 * disappeared, or its severity/detail/ack flipped) so the poller can publish a
 * single `health.updated` only when something an operator would see actually
 * moved - never on a steady-state cycle.
 *
 * Ack invalidation (ADR-0015 §4): if an existing advisory's severity or detail
 * materially changes, its `acknowledged_at` is cleared in the same upsert so it
 * re-alerts; an unchanged advisory keeps its ack. The comparison is column-vs-
 * bind in SQL, so no dialect Date trap.
 *
 * `immediate` (a user-initiated probe - Test/Refresh): the result is
 * authoritative, so a new advisory is made visible AT ONCE rather than waiting
 * out the ≥2-cycle debounce. Implemented by backdating `first_seen_at` so
 * `last_seen_at > first_seen_at` holds on first sighting. The background poll
 * leaves it false (debounced) so a single failed poll never rings the bell.
 */
export async function syncBackendAdvisories(
  backendId: string,
  evaluated: readonly EvaluatedAdvisory[],
  opts: { immediate?: boolean } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        code: backendAdvisories.code,
        severity: backendAdvisories.severity,
        detail: backendAdvisories.detail,
        firstSeenAt: backendAdvisories.firstSeenAt,
        lastSeenAt: backendAdvisories.lastSeenAt,
        acknowledgedAt: backendAdvisories.acknowledgedAt,
      })
      .from(backendAdvisories)
      .where(eq(backendAdvisories.backendId, backendId));
    const existingByCode = new Map(existing.map((r) => [r.code, r]));

    // Bell-visible set BEFORE this sync (confirmed = seen on ≥2 cycles).
    const before = new Set(
      existing.filter((r) => r.lastSeenAt > r.firstSeenAt).map((r) => visibleSig(r)),
    );

    const codes = evaluated.map((e) => e.code);
    // Prune advisories that no longer apply to this backend.
    await tx
      .delete(backendAdvisories)
      .where(
        codes.length === 0
          ? eq(backendAdvisories.backendId, backendId)
          : and(
              eq(backendAdvisories.backendId, backendId),
              notInArray(backendAdvisories.code, codes),
            ),
      );

    const now = new Date();
    // For an authoritative (immediate) probe, backdate first_seen so a brand-new
    // advisory is visible at once; the poll path keeps first==last (debounced).
    const firstSeen = opts.immediate ? new Date(now.getTime() - 60_000) : now;
    for (const a of evaluated) {
      await tx
        .insert(backendAdvisories)
        .values({
          backendId,
          code: a.code,
          severity: a.severity,
          title: a.title,
          detail: a.detail,
          firstSeenAt: firstSeen,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [backendAdvisories.backendId, backendAdvisories.code],
          // Preserve first_seen_at (debounce). Preserve acknowledged_at only
          // while severity + detail are unchanged; a material change re-alerts.
          set: {
            severity: a.severity,
            title: a.title,
            detail: a.detail,
            lastSeenAt: now,
            acknowledgedAt: sql`CASE WHEN ${backendAdvisories.detail} = ${a.detail} AND ${backendAdvisories.severity} = ${a.severity} THEN ${backendAdvisories.acknowledgedAt} ELSE NULL END`,
          },
        });
    }

    // Bell-visible set AFTER, derived without a second round-trip: a brand-new
    // code is inserted with first==last (not yet visible); an existing code
    // becomes/stays visible (last=now > first), with ack cleared iff its
    // severity/detail changed.
    const after = new Set<string>();
    for (const a of evaluated) {
      const prev = existingByCode.get(a.code);
      // A first sighting is normally debounced (not visible); an immediate probe
      // backdates first_seen, so it's visible at once.
      if (!prev && !opts.immediate) continue;
      // A missing prev (brand-new, immediate) counts as "changed" too.
      const materiallyChanged = prev?.detail !== a.detail || prev?.severity !== a.severity;
      after.add(
        visibleSig({
          code: a.code,
          severity: a.severity,
          detail: a.detail,
          acknowledgedAt: materiallyChanged ? null : (prev?.acknowledgedAt ?? null),
        }),
      );
    }

    if (before.size !== after.size) return true;
    for (const s of after) if (!before.has(s)) return true;
    return false;
  });
}

export interface ActiveAdvisory {
  id: string;
  backendId: string;
  backendName: string;
  backendSlug: string;
  code: string;
  severity: string;
  title: string;
  detail: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  acknowledgedAt: Date | null;
}

/**
 * Confirmed advisories (seen on ≥2 cycles) joined with backend identity.
 * Ordered errors-first, then by backend name. Includes acknowledged ones so the
 * bell can list them under the unacked count.
 */
export async function listActiveAdvisories(): Promise<ActiveAdvisory[]> {
  const rows = await db
    .select({
      id: backendAdvisories.id,
      backendId: backendAdvisories.backendId,
      backendName: pdnsServers.name,
      backendSlug: pdnsServers.slug,
      code: backendAdvisories.code,
      severity: backendAdvisories.severity,
      title: backendAdvisories.title,
      detail: backendAdvisories.detail,
      firstSeenAt: backendAdvisories.firstSeenAt,
      lastSeenAt: backendAdvisories.lastSeenAt,
      acknowledgedAt: backendAdvisories.acknowledgedAt,
    })
    .from(backendAdvisories)
    .innerJoin(pdnsServers, eq(pdnsServers.id, backendAdvisories.backendId))
    .where(gt(backendAdvisories.lastSeenAt, backendAdvisories.firstSeenAt))
    // errors before warnings before info, then stable by backend.
    .orderBy(
      sql`CASE ${backendAdvisories.severity} WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`,
      pdnsServers.name,
    );
  return rows.map((r) => ({ ...r, acknowledgedAt: r.acknowledgedAt ?? null }));
}

/** Acknowledge a single advisory by id. Returns true if a row was updated. */
export async function acknowledgeAdvisory(id: string): Promise<boolean> {
  const updated = await db
    .update(backendAdvisories)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(backendAdvisories.id, id), isNull(backendAdvisories.acknowledgedAt)))
    .returning({ id: backendAdvisories.id });
  return updated.length > 0;
}
