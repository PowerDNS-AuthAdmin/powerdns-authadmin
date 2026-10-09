/**
 * lib/pdns/serial-sync.ts
 *
 * The one rule for "has this mirror caught up with its primary?", shared by
 * every surface that answers it: the zone page, the zones list, the header
 * chip, the servers page and the poller's drift tracking (issue #146).
 *
 * PowerDNS reports two serials for a zone. `serial` is the raw value stored
 * in the backend; `edited_serial` is that value after SOA-EDIT, and it is
 * what the primary actually serves in SOA answers and AXFR. A secondary only
 * ever sees the served value, so the mirror's stored `serial` has to be
 * compared against the primary's `edited_serial` - comparing raw against raw
 * reports every SOA-EDIT zone as permanently out of sync.
 *
 * Pure - no I/O, no `server-only` - so the rules are unit-testable and usable
 * from client components.
 */

export type SyncState =
  | "in-sync"
  // Behind only because a time-based SOA-EDIT (INCREMENT-WEEKS, INCEPTION-*)
  // advanced the primary's served serial at the weekly boundary. PowerDNS
  // sends no NOTIFY for that, so the mirror picks it up at its next SOA
  // refresh. Expected, not drift.
  | "refresh-due"
  // The mirror holds a HIGHER serial than the primary serves. A secondary
  // never transfers a lower serial, so it keeps serving stale data until the
  // primary passes it (zone recreated with a lower serial, SOA-EDIT removed).
  | "ahead"
  | "lagging"
  | "missing"
  | "error";

/** States that mean the mirror is serving what it should - not drift. */
export function isSettledSyncState(state: SyncState): boolean {
  return state === "in-sync" || state === "refresh-due";
}

export interface ZoneSerials {
  serial: number | null;
  editedSerial: number | null;
  /**
   * The primary's SOA-EDIT kind, when known. Only `EPOCH` changes the rule:
   * every other time-based kind rolls over weekly, EPOCH serves `time()`.
   */
  soaEdit?: string | null;
}

/**
 * SOA-EDIT=EPOCH serves the current Unix time as the serial, so a mirror's
 * stored serial is the second its last transfer happened and the primary's
 * served serial is always ahead of it. Comparing them can only ever say
 * "lagging"; what the mirror's serial really tells us is how long ago it
 * refreshed.
 */
function isEpochSoaEdit(kind: string | null | undefined): boolean {
  return (kind ?? "").trim().toUpperCase() === "EPOCH";
}

/** The serial a primary serves (SOA answers + AXFR): post-SOA-EDIT, else raw. */
export function servedSerial(zone: ZoneSerials): number | null {
  return zone.editedSerial ?? zone.serial;
}

/** `servedSerial` for a PDNS API zone object (snake_case wire shape). */
export function servedSerialOfZone(zone: {
  serial?: number | null;
  edited_serial?: number | null;
}): number | null {
  return zone.edited_serial ?? zone.serial ?? null;
}

const WEEK_MS = 7 * 86_400_000;
/** PowerDNS' default SOA refresh (default-soa-content), used when the zone's is unknown. */
export const DEFAULT_SOA_REFRESH_SECONDS = 10_800;
// A secondary notices a due refresh on its next xfr cycle (60 s by default),
// and the app only sees the result on its next poll - allow for both.
const REFRESH_GRACE_MARGIN_MS = 5 * 60_000;

/**
 * How long after the weekly SOA-EDIT rollover a lagging mirror is still
 * "refresh due" rather than "lagging": one SOA refresh interval plus margin.
 */
export function soaEditRolloverGraceMs(refreshSeconds?: number | null): number {
  const refresh =
    refreshSeconds != null && refreshSeconds > 0 ? refreshSeconds : DEFAULT_SOA_REFRESH_SECONDS;
  return Math.min(refresh * 1000 + REFRESH_GRACE_MARGIN_MS, WEEK_MS);
}

/**
 * True while `now` is within the grace window after the most recent weekly
 * rollover. PowerDNS computes every time-based SOA-EDIT kind from whole weeks
 * since the Unix epoch, so the served serial changes at each multiple of 7
 * days since 1970-01-01 (Thursday 00:00 UTC).
 */
export function withinSoaEditRolloverGrace(now: number, refreshSeconds?: number | null): boolean {
  return now % WEEK_MS < soaEditRolloverGraceMs(refreshSeconds);
}

export interface ClassifyOptions {
  /** Epoch ms; injectable for tests. */
  now?: number;
  /** The zone's SOA refresh in seconds, when the caller has the SOA to hand. */
  refreshSeconds?: number | null;
}

/**
 * Classify one mirror's copy of a zone against the primary's.
 *
 * `mirror` is null when the mirror doesn't hold the zone at all. A mirror's
 * own `serial` is what it stored from the transfer; its `edited_serial` is
 * deliberately ignored (a mirror doesn't re-apply the primary's SOA-EDIT).
 */
export function classifyMirrorSerial(
  primary: ZoneSerials,
  mirror: { serial: number | null } | null,
  opts: ClassifyOptions = {},
): SyncState {
  if (!mirror) return "missing";
  const served = servedSerial(primary);
  if (served === null || mirror.serial === null) return "error";
  if (mirror.serial === served) return "in-sync";
  if (mirror.serial > served) return "ahead";
  if (isEpochSoaEdit(primary.soaEdit)) {
    // The mirror's serial is the Unix time of its last transfer. It is current
    // if that was within one SOA refresh (plus margin) - the mirror re-transfers
    // on every refresh because the served serial always moved - and genuinely
    // lagging only when it has missed that cycle.
    const nowMs = opts.now ?? Date.now();
    const ageMs = nowMs - mirror.serial * 1000;
    return ageMs <= soaEditRolloverGraceMs(opts.refreshSeconds ?? null) ? "refresh-due" : "lagging";
  }
  const soaEditActive =
    primary.editedSerial !== null &&
    primary.serial !== null &&
    primary.editedSerial !== primary.serial;
  if (
    soaEditActive &&
    withinSoaEditRolloverGrace(opts.now ?? Date.now(), opts.refreshSeconds ?? null)
  ) {
    return "refresh-due";
  }
  return "lagging";
}

/**
 * The SOA refresh (seconds) from a zone's rrsets, or null when the zone was
 * fetched without rrsets or the SOA content doesn't parse.
 */
export function soaRefreshSeconds(
  zoneName: string,
  rrsets: ReadonlyArray<{
    name: string;
    type: string;
    records: ReadonlyArray<{ content: string }>;
  }>,
): number | null {
  const soa = rrsets.find((r) => r.type === "SOA" && r.name === zoneName);
  const content = soa?.records[0]?.content;
  if (!content) return null;
  // mname rname serial refresh retry expire minimum
  const refresh = Number(content.trim().split(/\s+/)[3]);
  return Number.isInteger(refresh) && refresh > 0 ? refresh : null;
}
