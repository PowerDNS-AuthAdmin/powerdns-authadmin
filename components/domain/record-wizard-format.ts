/**
 * components/domain/record-wizard-format.ts
 *
 * The decisions the Add record wizard makes without a DOM: which step it
 * starts on, how a typed owner name becomes a canonical one, what the PATCH
 * body looks like when the RRset already exists, and how a replication member
 * is coloured. Pure so the wizard's branching is unit-tested here and the
 * component only renders.
 *
 * Name conventions mirror the records editor (`editable-record-table.tsx`):
 * "@" or an empty label is the apex, a trailing dot means "already
 * fully-qualified", anything else is relative to the zone.
 */

import { isAddressType } from "@/lib/dns/auto-ptr";

export type WizardHorizon = "public" | "internal";

/** One hit from `GET /api/admin/pdns/zones/search`. */
export interface WizardZoneHit {
  name: string;
  server: string;
  serverName: string;
  cluster: string | null;
  horizon: WizardHorizon;
  kind: string;
  reverse: boolean;
  canCreate: boolean;
}

/** One RRset from `GET /api/admin/pdns/zones/<zone>/records`. */
export interface ExistingRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
  comment: string;
}

/** The wire shape of one `upsert` change for `PATCH .../rrsets`. */
export interface UpsertChange {
  kind: "upsert";
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
  comment?: string;
  ptr?: boolean;
}

/** TTL the record step opens with; the zone's own default applies on the records page. */
export const WIZARD_DEFAULT_TTL = 3600;

export function canonicalizeRecordName(input: string, zoneName: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "@") return zoneName;
  if (trimmed.endsWith(".")) return trimmed;
  return `${trimmed}.${zoneName}`;
}

/** The relative label for a canonical owner name; `"@"` at the apex. */
export function displayRecordName(name: string, zoneName: string): string {
  if (name === zoneName) return "@";
  if (name.endsWith(`.${zoneName}`)) return name.slice(0, name.length - zoneName.length - 1);
  return name;
}

/**
 * Where the wizard opens. The horizon question is only worth asking when
 * both horizons hold zones; with one (or none) the answer is already known.
 * A deep link that names the zone skips the question entirely.
 */
export function wizardStartStep(
  horizons: { public: number; internal: number },
  hasPrefilledZone: boolean,
): { step: "horizon" | "zone"; horizon: WizardHorizon | null } {
  if (hasPrefilledZone) return { step: "zone", horizon: null };
  if (horizons.public > 0 && horizons.internal > 0) return { step: "horizon", horizon: null };
  if (horizons.internal > 0) return { step: "zone", horizon: "internal" };
  return { step: "zone", horizon: "public" };
}

export interface RecordDraftInput {
  zoneName: string;
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled: boolean;
  comment: string;
  /** The "Keep the reverse (PTR) record in sync" box. */
  ptr: boolean;
  /** The RRset already at (name, type), when the existence check found one. */
  existing: ExistingRRset | null;
}

/**
 * The single change the wizard sends. When the RRset exists the new value is
 * appended to it (PowerDNS replaces the whole RRset, so the existing values
 * travel along), otherwise a one-record RRset is created.
 *
 * `comment` is sent only when the operator wrote one: an omitted comment
 * leaves an existing RRset's comments untouched, which is what "append a
 * value" should mean. `ptr` is sent only when the box is ticked, so an
 * unticked box defers to the zone's / the global auto-PTR setting instead of
 * forcing it off.
 */
export function buildUpsertChange(input: RecordDraftInput): {
  change: UpsertChange;
  mode: "create" | "append";
} {
  const name = canonicalizeRecordName(input.name, input.zoneName);
  const type = input.type.toUpperCase();
  const newRecord = input.disabled
    ? { content: input.content.trim(), disabled: true }
    : { content: input.content.trim() };
  const existing = input.existing;
  const records = existing ? [...existing.records, newRecord] : [newRecord];
  const comment = input.comment.trim();
  const change: UpsertChange = {
    kind: "upsert",
    name,
    type,
    ttl: input.ttl,
    records,
    ...(comment !== "" ? { comment } : {}),
    ...(input.ptr && isAddressType(type) ? { ptr: true } : {}),
  };
  return { change, mode: existing ? "append" : "create" };
}

/** The review step's one-line summary and the success toast's text. */
export function describeRecordChange(
  mode: "create" | "append",
  change: UpsertChange,
  zoneName: string,
): string {
  const owner = change.name === zoneName ? `the apex of ${zoneName}` : change.name;
  const value = change.records[change.records.length - 1]?.content ?? "";
  if (mode === "append") {
    return `Adds the value "${value}" to the existing ${change.type} RRset at ${owner} (${change.records.length} values after save).`;
  }
  return `Creates a ${change.type} record at ${owner} with the value "${value}" (TTL ${change.ttl}).`;
}

/** Tooltip body for the "already exists" badge: one value per line. */
export function describeExistingValues(rrset: ExistingRRset): string {
  const lines = rrset.records.map(
    (r) => `${r.disabled ? "(disabled) " : ""}${r.content}  TTL ${rrset.ttl}`,
  );
  if (rrset.comment.trim() !== "") lines.push(`Comment: ${rrset.comment.trim()}`);
  return lines.join("\n");
}

/** The zone's records page, scoped to the backend the record was written to. */
export function recordsPageHref(zoneName: string, serverSlug: string): string {
  return `/zones/${encodeURIComponent(zoneName)}?server=${encodeURIComponent(serverSlug)}`;
}

/**
 * How one replication member renders on the propagation step. The states are
 * the poller's `SyncState` plus `unknown` (serial not observed yet). Settled
 * states are green; a catch-up in flight is orange; a copy that is missing or
 * errored is red; an unobserved one is quiet until the poller reports.
 */
export function syncMemberAppearance(state: string): {
  indicator: "synced" | "desynced";
  tone: "success" | "warn" | "error";
  label: string;
  settled: boolean;
} {
  switch (state) {
    case "in-sync":
      return { indicator: "synced", tone: "success", label: "synced", settled: true };
    case "refresh-due":
      return { indicator: "synced", tone: "success", label: "refresh due", settled: true };
    case "lagging":
    case "ahead":
    case "unknown":
      return {
        indicator: "desynced",
        tone: "warn",
        label: state === "unknown" ? "waiting" : state,
        settled: false,
      };
    default:
      return { indicator: "desynced", tone: "error", label: state, settled: false };
  }
}

/** URL prefill (`?zone=&server=&name=&type=&content=`) as the wizard reads it. */
export interface WizardPrefill {
  zone: string | null;
  server: string | null;
  name: string;
  type: string | null;
  content: string;
}

export function parseWizardPrefill(params: Record<string, string | undefined>): WizardPrefill {
  const zone = params["zone"]?.trim().toLowerCase() ?? "";
  const server = params["server"]?.trim() ?? "";
  const type = params["type"]?.trim().toUpperCase() ?? "";
  return {
    zone: zone === "" ? null : zone.endsWith(".") ? zone : `${zone}.`,
    server: server === "" ? null : server,
    name: params["name"]?.trim() ?? "",
    type: /^[A-Z0-9]{1,12}$/.test(type) ? type : null,
    content: params["content"] ?? "",
  };
}
