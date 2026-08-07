/**
 * components/domain/capability-badges.tsx
 *
 * Tinted badges for a backend's observed PDNS capabilities - one per role the
 * daemon reports ON. Colour-coded by role so the page can be skimmed at a glance:
 *   • primary       → accent (indigo) - write target
 *   • secondary     → warn   (yellow) - read-only mirror
 *   • autosecondary → orange - accepts NOTIFY-from-anyone auto-create
 *   • standalone    → neutral - no replication flag set (default PDNS Auth
 *                     config; API still accepts zone creates - fully usable).
 *
 * Plus one observed capability that isn't a replication role:
 *   • lua records   → orange - `enable-lua-records` is `yes` or `shared` (#122).
 *                     Shares autosecondary's tone because both mark a daemon
 *                     doing something beyond plain authoritative serving; the
 *                     label carries the distinction. Rendered last so the
 *                     replication roles keep their leading position, and never
 *                     suppressed by `standalone` - a standalone daemon with Lua
 *                     armed is exactly the case the operator must see.
 *
 * Plus one badge that is NOT observed but operator-declared:
 *   • read-only     → warn (yellow) - `write_mode='read_only'` (#111). Shown
 *                     first, because it overrides whatever the daemon reports:
 *                     a node badged `standalone read-only` looks writable to
 *                     PDNS but the operator has vetoed writes to it.
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
  /** `enable-lua-records` mode. Absent on snapshots taken before #122 - that's
   *  "not observed", so no badge either way, rather than a claim of "off". */
  luaRecords?: "no" | "yes" | "shared";
}

// Same recipe as the CLUSTER badge in the zones list and the DEFAULT badge in
// the servers list - rounded, mono, tracking-wide, uppercase, bg-<tone>/15 -
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
  lua: `${BASE} bg-[color:var(--color-orange)]/15 text-[color:var(--color-orange-fg)]`,
} as const;

interface Badge {
  key: string;
  className: string;
  label: string;
  title?: string;
}

export function CapabilityBadges({
  capabilities,
  writeMode = "auto",
}: {
  capabilities: Capabilities | null;
  /** Operator write-routing override (#111). "read_only" adds a leading badge. */
  writeMode?: "auto" | "read_only";
}) {
  const badges: Badge[] = [];

  // First, because it overrides whatever the daemon reports.
  if (writeMode === "read_only") {
    badges.push({
      key: "read-only",
      className: TONE.secondary,
      label: "read-only",
      title: "Operator override: writes are never routed here",
    });
  }

  if (!capabilities) {
    badges.push({ key: "unprobed", className: NEUTRAL, label: "unprobed" });
  } else {
    const roles = (["primary", "secondary", "autosecondary"] as const).filter(
      (role) => capabilities[role],
    );
    if (roles.length === 0) {
      badges.push({ key: "standalone", className: NEUTRAL, label: "standalone" });
    } else {
      for (const role of roles) badges.push({ key: role, className: TONE[role], label: role });
    }
    // Not a replication role, so it rides alongside `standalone` rather than
    // being displaced by it.
    const lua = capabilities.luaRecords;
    if (lua === "yes" || lua === "shared") {
      badges.push({
        key: "lua",
        className: TONE.lua,
        label: lua === "shared" ? "lua records (shared)" : "lua records",
        title: `enable-lua-records=${lua} - this daemon arms LUA records (executable server-side code) for every zone it serves`,
      });
    }
  }

  // Plain inline <span> wrapper (no flex) so each badge renders exactly like
  // the CLUSTER badge in the zones list - inherited line-height and no
  // cross-axis stretching from a flex container.
  return (
    <span className="whitespace-nowrap">
      {badges.map((b, i) => (
        <span key={b.key} className={i > 0 ? `${b.className} ml-1` : b.className} title={b.title}>
          {b.label}
        </span>
      ))}
    </span>
  );
}
