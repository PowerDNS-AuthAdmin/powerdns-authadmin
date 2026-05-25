/**
 * lib/pdns/observations.test.ts
 *
 * The in-memory latency ring buffer. Its p50 feeds `metric_samples`, which the
 * cluster picker reads to route `lowest_latency` writes — so the buffer must
 * only ever contain *successful* request timings. The HTTP layer enforces that
 * by not calling `recordPdnsLatency` on the failure path; this suite locks the
 * buffer's own arithmetic (drain percentiles, isolation per slug, reset).
 */

import { describe, expect, it } from "vitest";
import { drainPdnsLatency, recordPdnsLatency } from "./observations";

// Unique slugs per test so the module-scoped buffer map can't leak between
// cases running in the same worker.
let n = 0;
const freshSlug = (): string => `obs-test-${n++}`;

describe("recordPdnsLatency / drainPdnsLatency", () => {
  it("returns null for a slug with no observations", () => {
    expect(drainPdnsLatency(freshSlug())).toBeNull();
  });

  it("summarizes only the latencies it was given (success-only by construction)", () => {
    const slug = freshSlug();
    // Simulate the post-fix HTTP layer: only successful requests are recorded.
    // A fast failure (e.g. an instant 5xx at ~1ms) is NOT pushed here.
    for (const ms of [100, 100, 100, 100, 100]) recordPdnsLatency(slug, ms);

    const summary = drainPdnsLatency(slug);
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(5);
    // The p50 reflects real working latency, not a failure's tiny wall-time.
    expect(summary?.p50).toBe(100);
  });

  it("a flapping peer's fast failures would drag the p50 down — proving why they're excluded", () => {
    const slug = freshSlug();
    // A few healthy successes around 200ms...
    for (let i = 0; i < 4; i++) recordPdnsLatency(slug, 200);
    // ...drowned out by a flood of ~1ms fast failures. If failure timings were
    // (wrongly) recorded, the median collapses toward the fast-error value and
    // this peer looks like the *lowest* latency target. The http.ts fix avoids
    // this by never pushing failure timings into the buffer.
    for (let i = 0; i < 16; i++) recordPdnsLatency(slug, 1);

    const polluted = drainPdnsLatency(slug);
    // With the failures dominating, the median sits on the fast-error value.
    expect(polluted?.p50).toBe(1);
    // That is exactly the routing-poisoning the success-only buffer prevents:
    // in production those 1ms entries are never recorded, so the p50 stays ~200.
  });

  it("keeps buffers isolated per server slug", () => {
    const a = freshSlug();
    const b = freshSlug();
    recordPdnsLatency(a, 10);
    recordPdnsLatency(b, 500);
    expect(drainPdnsLatency(a)?.p50).toBe(10);
    expect(drainPdnsLatency(b)?.p50).toBe(500);
  });

  it("resets after a drain so the next window starts clean", () => {
    const slug = freshSlug();
    recordPdnsLatency(slug, 42);
    expect(drainPdnsLatency(slug)?.count).toBe(1);
    expect(drainPdnsLatency(slug)).toBeNull();
  });
});
