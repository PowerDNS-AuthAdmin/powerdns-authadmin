/**
 * The create-zone page only reads from the local DB (servers list +
 * templates list) - sub-50ms in practice. The default behaviour
 * (parent `/zones/loading.tsx` firing) shimmered the whole zone-list
 * table for the brief gap, which felt out of place for a route that
 * just renders a form.
 *
 * Returning null here opts out: Next.js keeps the previous page visible
 * until the new RSC payload is ready, then swaps - no shimmer flash.
 */

export default function NewZoneLoading() {
  return null;
}
