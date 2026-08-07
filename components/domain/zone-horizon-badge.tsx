/**
 * components/domain/zone-horizon-badge.tsx
 *
 * The INTERNAL badge - "this copy of the zone is the internal one" (#121,
 * ADR-0022). Rendered next to the CLUSTER badge in the zones list and next to
 * the zone name on zone detail, so a fleet running split-horizon reads as
 * `[CLUSTER] [INTERNAL]` at a glance rather than as two mystery rows with the
 * same name.
 *
 * Only `internal` gets a badge. `public` is the default horizon - badging it
 * would put a marker on nearly every row and stop the badge meaning anything.
 *
 * Same recipe as `capability-badges.tsx` and the CLUSTER badge (rounded, mono,
 * tracking-wide, uppercase, `bg-<tone>/15`) so every inline state badge in the
 * app reads as one family. Orange because it must not be confused with the
 * indigo CLUSTER badge beside it, nor with the green the Sync column uses for
 * "synced" - and because "you are not looking at the public copy" is worth a
 * second glance.
 */

import { type ZoneHorizon } from "@/lib/dns/zone-horizon";

const BADGE =
  "rounded bg-[color:var(--color-orange)]/15 px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-orange-fg)] uppercase";

const TITLE =
  "Internal zone - listed separately from a public zone of the same name (split horizon)";

/** Badge for a zone's horizon; renders nothing for the default (`public`). */
export function ZoneHorizonBadge({
  horizon,
  className,
}: {
  horizon: ZoneHorizon;
  /** Extra classes for spacing at the call site (e.g. `ml-2`). */
  className?: string;
}) {
  if (horizon !== "internal") return null;
  return (
    <span className={className ? `${BADGE} ${className}` : BADGE} title={TITLE}>
      internal
    </span>
  );
}
