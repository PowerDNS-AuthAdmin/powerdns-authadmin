import { beforeEach, describe, expect, it } from "vitest";
import { _resetRoundRobinIndex, pickPeer, type PeerSamples } from "./cluster-picker-pure";

const peer = (id: string, slug = id) => ({ id, slug });

describe("pickPeer round_robin", () => {
  beforeEach(() => {
    _resetRoundRobinIndex();
  });

  it("returns null on empty peers", () => {
    expect(pickPeer({ id: "c", writeStrategy: "round_robin" }, [])).toBeNull();
  });

  it("returns the sole peer when len=1", () => {
    const p = peer("p1");
    expect(pickPeer({ id: "c", writeStrategy: "round_robin" }, [p])).toBe(p);
  });

  it("rotates across calls within a cluster", () => {
    const peers = [peer("a"), peer("b"), peer("c")];
    const cluster = { id: "c1", writeStrategy: "round_robin" as const };
    const sequence = [
      pickPeer(cluster, peers)?.id,
      pickPeer(cluster, peers)?.id,
      pickPeer(cluster, peers)?.id,
      pickPeer(cluster, peers)?.id,
    ];
    expect(sequence).toEqual(["a", "b", "c", "a"]);
  });

  it("keeps rotating after a full wrap (shared globalThis cursor survives)", () => {
    // Regression for the RR index moving onto globalThis: the cursor must keep
    // advancing past the peer-count boundary instead of being silently reset
    // by a duplicated module instance restarting at 0.
    const peers = [peer("a"), peer("b")];
    const cluster = { id: "wrap", writeStrategy: "round_robin" as const };
    const seq = Array.from({ length: 5 }, () => pickPeer(cluster, peers)?.id);
    expect(seq).toEqual(["a", "b", "a", "b", "a"]);
  });

  it("tracks RR index per cluster independently", () => {
    const peers = [peer("a"), peer("b")];
    expect(pickPeer({ id: "x", writeStrategy: "round_robin" }, peers)?.id).toBe("a");
    expect(pickPeer({ id: "y", writeStrategy: "round_robin" }, peers)?.id).toBe("a");
    expect(pickPeer({ id: "x", writeStrategy: "round_robin" }, peers)?.id).toBe("b");
    expect(pickPeer({ id: "y", writeStrategy: "round_robin" }, peers)?.id).toBe("b");
  });
});

describe("pickPeer lowest_latency", () => {
  it("picks the peer with min p50 latency", () => {
    const peers = [peer("a"), peer("b"), peer("c")];
    const samples: PeerSamples = {
      latencyP50Ms: new Map([
        ["a", 50],
        ["b", 12],
        ["c", 80],
      ]),
      zoneCounts: new Map(),
    };
    expect(pickPeer({ id: "c1", writeStrategy: "lowest_latency" }, peers, samples)?.id).toBe("b");
  });

  it("treats missing samples as +Infinity so a measured peer always wins", () => {
    const peers = [peer("a"), peer("b")];
    const samples: PeerSamples = {
      latencyP50Ms: new Map([["b", 999]]),
      zoneCounts: new Map(),
    };
    expect(pickPeer({ id: "c1", writeStrategy: "lowest_latency" }, peers, samples)?.id).toBe("b");
  });

  it("falls back to first peer when samples are absent", () => {
    const peers = [peer("a"), peer("b")];
    expect(pickPeer({ id: "c1", writeStrategy: "lowest_latency" }, peers)?.id).toBe("a");
  });

  it("a fast-failing peer never becomes the lowest_latency choice", () => {
    // Regression for the failure-latency pollution bug: requests that FAIL no
    // longer feed the latency buffer, so a peer that only ever returns fast
    // errors records no success-latency sample at all. With no sample it sorts
    // to +Infinity and must lose to a slower-but-working peer. (Before the fix,
    // its tiny error wall-time would have made it the preferred write target.)
    const failingFast = peer("fail-fast");
    const slowButHealthy = peer("healthy");
    const samples: PeerSamples = {
      // Only the healthy peer recorded a (success) latency. The failing peer is
      // absent - modelling the buffer no longer ingesting its failure timings.
      latencyP50Ms: new Map([["healthy", 300]]),
      zoneCounts: new Map(),
    };
    const choice = pickPeer(
      { id: "c1", writeStrategy: "lowest_latency" },
      [failingFast, slowButHealthy],
      samples,
    );
    expect(choice?.id).toBe("healthy");
  });
});

describe("pickPeer least_load", () => {
  it("picks the peer with min zone count", () => {
    const peers = [peer("a"), peer("b"), peer("c")];
    const samples: PeerSamples = {
      latencyP50Ms: new Map(),
      zoneCounts: new Map([
        ["a", 200],
        ["b", 50],
        ["c", 120],
      ]),
    };
    expect(pickPeer({ id: "c1", writeStrategy: "least_load" }, peers, samples)?.id).toBe("b");
  });
});

describe("pickPeer random", () => {
  it("returns one of the peers", () => {
    const peers = [peer("a"), peer("b"), peer("c")];
    const ids = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const p = pickPeer({ id: "c1", writeStrategy: "random" }, peers);
      if (p) ids.add(p.id);
    }
    // With 30 draws across 3 peers we should hit each at least once
    // (probability of missing one ≈ (2/3)^30 ≈ 5e-6).
    expect(ids.size).toBe(3);
  });
});
