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

// Same recipe as the CLUSTER badge in the zones list and the DEFAULT badge in
// the servers list — rounded, mono, tracking-wide, uppercase, bg-<tone>/15 —
// so every inline role/state badge in the app reads as one family. Yellow and
// orange need a darker -fg variant for the text (their semantic hue is too
// light to read on top of a /15 tint of itself; accent indigo is dark enough
// that text-accent works without a separate fg token).
const BASE = "rounded px-1 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase";

const NEUTRAL = `${BASE} bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg-muted)]`;

const TONE = {
  primary: `${BASE} bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]`,
  secondary: `${BASE} bg-[color:var(--color-warn)]/15 text-[color:var(--color-warn-fg)]`,
  autosecondary: `${BASE} bg-[color:var(--color-orange)]/15 text-[color:var(--color-orange-fg)]`,
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
