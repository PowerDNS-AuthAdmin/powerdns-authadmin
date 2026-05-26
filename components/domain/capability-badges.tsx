/**
 * components/domain/capability-badges.tsx
 *
 * Tinted badges for a backend's observed PDNS capabilities — one per role the
 * daemon reports ON. Colour-coded by role so the page can be skimmed at a glance:
 *   • primary       → accent (indigo) — write target
 *   • secondary     → warn   (yellow) — read-only mirror
 *   • autosecondary → orange — accepts NOTIFY-from-anyone auto-create
 *
 * Renders nothing fancy: a small rounded badge per active flag, joined by a
 * narrow gap. Use anywhere a backend row shows its role (server lists, group
 * detail, server detail).
 */

/** Subset of the capability flags this component cares about. Declared locally
 *  so the UI layer doesn't reach into lib/pdns (the three-layer rule); any
 *  PdnsDaemonCapabilities value structurally satisfies it. */
interface Capabilities {
  primary: boolean;
  secondary: boolean;
  autosecondary: boolean;
}

const BASE =
  "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[0.65rem] font-medium";

const NEUTRAL = `${BASE} border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-fg-muted)]`;

// Tints use color-mix so they sit on either theme without re-defining.
const TONE = {
  primary: `${BASE} border-[color:var(--color-accent)]/40 bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)] text-[color:var(--color-accent)]`,
  secondary: `${BASE} border-[color:var(--color-warn)]/40 bg-[color-mix(in_oklch,var(--color-warn)_14%,transparent)] text-[color:var(--color-warn)]`,
  autosecondary: `${BASE} border-[color:var(--color-orange)]/40 bg-[color-mix(in_oklch,var(--color-orange)_14%,transparent)] text-[color:var(--color-orange)]`,
} as const;

export function CapabilityBadges({ capabilities }: { capabilities: Capabilities | null }) {
  if (!capabilities) return <span className={NEUTRAL}>unprobed</span>;
  const flags: Array<keyof typeof TONE> = [];
  if (capabilities.primary) flags.push("primary");
  if (capabilities.secondary) flags.push("secondary");
  if (capabilities.autosecondary) flags.push("autosecondary");
  if (flags.length === 0) return <span className={NEUTRAL}>none</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {flags.map((f) => (
        <span key={f} className={TONE[f]}>
          {f}
        </span>
      ))}
    </span>
  );
}
