/**
 * lib/pdns/observations.ts
 *
 * In-memory ring buffer of recent PdnsClient request latencies, keyed by
 * server slug. The sampler (`lib/metrics/sampler.ts`) drains it on each
 * dashboard load and writes p50/p95 into `metric_samples`.
 *
 * Why module-scoped: we don't want a separate buffer per HTTP request, and
 * the HTTP layer is already module-scoped. The buffer is bounded to keep
 * memory tame under heavy traffic. On process restart it resets — fine,
 * the dashboard just shows a brief gap.
 *
 * The HTTP layer (`lib/pdns/http.ts`) pushes after every *successful* request
 * via `recordPdnsLatency(serverSlug, ms)`. Pushing is O(1). Failures are
 * deliberately excluded: this buffer's p50 feeds the cluster picker's
 * `lowest_latency` routing, and a fast-failing peer must not look like a
 * low-latency one. Failure signal lives in the request log / audit row.
 */

import "server-only";

interface Buffer {
  /** Ring buffer of recent latencies in ms. */
  observations: number[];
  /** Write position. */
  next: number;
  /** True once `observations` has been fully populated at least once. */
  filled: boolean;
}

const CAPACITY = 1000;

const buffers = new Map<string, Buffer>();

export function recordPdnsLatency(serverSlug: string, ms: number): void {
  let buf = buffers.get(serverSlug);
  if (!buf) {
    buf = {
      observations: new Array<number>(CAPACITY).fill(0),
      next: 0,
      filled: false,
    };
    buffers.set(serverSlug, buf);
  }
  buf.observations[buf.next] = ms;
  buf.next = (buf.next + 1) % CAPACITY;
  if (buf.next === 0) buf.filled = true;
}

/**
 * Drain the buffer and return percentile summaries. Caller should write the
 * result to `metric_samples` and reset.
 */
export function drainPdnsLatency(
  serverSlug: string,
): { count: number; p50: number; p95: number } | null {
  const buf = buffers.get(serverSlug);
  if (!buf) return null;
  const size = buf.filled ? CAPACITY : buf.next;
  if (size === 0) return null;
  const slice = buf.observations.slice(0, size).sort((a, b) => a - b);
  const p50 = slice[Math.floor(size * 0.5)] ?? 0;
  const p95 = slice[Math.min(size - 1, Math.floor(size * 0.95))] ?? 0;

  // Reset the buffer so the next sample window starts clean.
  buf.observations.fill(0);
  buf.next = 0;
  buf.filled = false;

  return { count: size, p50, p95 };
}
