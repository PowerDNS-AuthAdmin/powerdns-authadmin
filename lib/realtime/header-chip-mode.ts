/**
 * lib/realtime/header-chip-mode.ts
 *
 * Pure decision for the header status chip's default mode. Extracted from
 * `app/(app)/layout.tsx` so the rule is unit-testable: every combination of
 * (polling-flag, realtime-available, can-read-backends, has-topology, lagging)
 * maps to exactly one ChipMode.
 *
 * The chip itself ALWAYS renders - what changes here is the *label* it shows:
 *
 *   - "live"  - connectivity pulse only ("Live"). Used when sync awareness is
 *               either unavailable (no realtime / no perms) or unimportant
 *               (no replication topology, or polling disabled so there is no
 *               live sync data to surface).
 *   - "sync"  - SYNCED / DESYNCED label, driven by `lagging`.
 *
 * The four gates from top to bottom (any one false → "live"):
 *   1. `PDNS_BACKGROUND_POLLING=true` - without the poller there is no live
 *      mirror state to display (v1.2.0 opt-in, #57).
 *   2. Realtime SSE bus is available - without it the chip can't even pulse
 *      from poller events.
 *   3. Actor can read backends (zone OR server perms) - a profile-only user
 *      shouldn't see a signal they have no context for.
 *   4. Fleet contains ≥1 cluster of 2+ peers - single-primary / standalone
 *      fleets have nothing to be in-sync against.
 */

export type ChipMode = { kind: "live" } | { kind: "sync"; inSync: boolean };

export interface ChipModeInput {
  pollingEnabled: boolean;
  realtimeAvailable: boolean;
  canReadBackends: boolean;
  hasReplicationTopology: boolean;
  anyLagging: boolean;
}

export function decideHeaderChipMode(input: ChipModeInput): ChipMode {
  if (
    !input.pollingEnabled ||
    !input.realtimeAvailable ||
    !input.canReadBackends ||
    !input.hasReplicationTopology
  ) {
    return { kind: "live" };
  }
  return { kind: "sync", inSync: !input.anyLagging };
}
