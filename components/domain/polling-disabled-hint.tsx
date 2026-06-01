/**
 * components/domain/polling-disabled-hint.tsx
 *
 * Gentle "(i)" inline hint surfaced beside a feature title (currently the
 * dashboard heading) when `PDNS_BACKGROUND_POLLING=false`. Hovering the icon
 * reveals a tooltip explaining the current state of the flag and pointing
 * at the live CONFIGURATION doc so an operator can flip it deliberately.
 *
 * Pairs with the `flash=polling-required` toast surfaced by direct ?tab=sync
 * / ?tab=statistics / ?tab=pdns hits - the redirect handles the loud "you
 * landed on a feature gated by this flag" path, while this hint is the
 * always-visible quiet nudge hanging off the dashboard heading.
 *
 * Server component (purely presentational + `<a>`), so it can be rendered
 * from any RSC tree.
 */

import { Info } from "lucide-react";

const DOC_URL =
  "https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/blob/main/docs/03-CONFIGURATION.md#pdns_background_polling";

const TOOLTIP =
  "PDNS_BACKGROUND_POLLING=false (currently). Set it true to enable the dashboard PowerDNS metrics, " +
  "the per-zone Sync + Statistics tabs, the servers-list lag column, and drift-derived advisories. " +
  "Single-server / standalone deployments don't need it; multi-replica + clustered fleets benefit from " +
  "the live sync awareness.";

export function PollingDisabledHint({ className }: { className?: string }) {
  return (
    <a
      href={DOC_URL}
      target="_blank"
      rel="noreferrer"
      title={TOOLTIP}
      aria-label="Background polling is disabled - click to see how to enable PDNS_BACKGROUND_POLLING"
      className={
        "inline-flex h-5 w-5 items-center justify-center rounded-full text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-muted)] hover:text-[color:var(--color-fg)] " +
        (className ?? "")
      }
    >
      <Info className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}
