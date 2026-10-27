/**
 * lib/client/map-pool.ts
 *
 * Runs an async task over a list with at most `limit` in flight, results in
 * input order. Bulk actions in the browser (reading or saving many zones) go
 * through this so a fleet-wide fix is a steady trickle of requests to the app,
 * not hundreds at once.
 */

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
