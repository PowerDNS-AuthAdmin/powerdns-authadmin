/**
 * components/ui/sync-indicator.tsx
 *
 * The concentric-circle glyph used wherever the UI states a replication
 * verdict ("Synced" / "Desynced"). Defined once so every consumer renders the
 * same shape + colour pairing - header chip, servers list, zones list all
 * agree on what "synced" looks like.
 *
 * Synced: a solid centre with two outward-pulsing rings (sonar/radar ping
 * effect via SVG SMIL - staggered 1.2 s apart so one ring is always travelling
 * outward as the other resets).
 * Desynced: a hollow centre ring with two static dashed concentric rings -
 * deliberately quiet, "frozen", to read as "stuck" rather than "active".
 *
 * Colour travels via `currentColor`; defaults map synced → `var(--color-success)`,
 * desynced → `var(--color-error)`. Stroke widths are tuned for the small inline
 * sizes (12–18 px) the chips render at - thicker than typical SVG defaults so
 * the rings stay legible without zooming.
 */

interface Props {
  state: "synced" | "desynced";
  /** Render size in pixels (square). 16 fits inline with `text-sm`. */
  size?: number;
  /**
   * Override the colour token. Defaults to `success` for synced and `error`
   * for desynced; pass `warn` to use the orange "transient AXFR catch-up"
   * tone (zones list per-row sync cell uses this for the ahead/lagging
   * states that aren't yet a hard error).
   */
  tone?: "success" | "warn" | "error";
  className?: string;
}

export function SyncIndicator({ state, size = 18, tone, className }: Props) {
  const effectiveTone = tone ?? (state === "synced" ? "success" : "error");
  const colorToken = `var(--color-${effectiveTone})`;
  return (
    <span aria-hidden style={{ color: colorToken, display: "inline-flex" }} className={className}>
      {state === "synced" ? (
        <svg width={size} height={size} viewBox="0 0 64 64" aria-label="In sync">
          <circle
            cx="32"
            cy="32"
            r="10"
            stroke="currentColor"
            fill="none"
            className="pda-sync-pulse-a"
          />
          <circle
            cx="32"
            cy="32"
            r="10"
            stroke="currentColor"
            fill="none"
            className="pda-sync-pulse-b"
          />
          <circle cx="32" cy="32" r="10" fill="currentColor" />
        </svg>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          aria-label="Out of sync"
        >
          <circle
            cx="32"
            cy="32"
            r="26"
            strokeWidth="4"
            opacity="0.4"
            strokeDasharray="5 5"
            className="pda-desync-ring-outer"
          />
          <circle
            cx="32"
            cy="32"
            r="18"
            strokeWidth="4"
            opacity="0.75"
            strokeDasharray="5 5"
            className="pda-desync-ring-inner"
          />
          <circle cx="32" cy="32" r="10" strokeWidth="6" />
        </svg>
      )}
    </span>
  );
}
