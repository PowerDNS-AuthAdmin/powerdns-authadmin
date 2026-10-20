/**
 * The Add record page itself only checks the session - the wizard fetches
 * its data client-side once mounted. The parent `/zones/loading.tsx` would
 * shimmer a zone table over that brief gap, which is the wrong shape for a
 * form. Returning null keeps the previous page visible until the RSC payload
 * is ready, same as the Add zone page.
 */

export default function NewRecordLoading() {
  return null;
}
