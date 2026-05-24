import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, mint, redeem } from "./temp-reveal-store";

// No REDIS_URL in the test env, so these exercise the in-process backend.
afterEach(() => {
  _resetForTests();
  vi.useRealTimers();
});

describe("temp-reveal-store", () => {
  it("redeems once and returns null on second call", async () => {
    const { token } = await mint({
      plaintext: "hunter2",
      allowedActorId: "actor-a",
    });
    expect(await redeem({ token, actorId: "actor-a" })).toEqual({
      plaintext: "hunter2",
    });
    expect(await redeem({ token, actorId: "actor-a" })).toBeNull();
  });

  it("rejects redemption by a different actor and burns the token", async () => {
    const { token } = await mint({
      plaintext: "hunter2",
      allowedActorId: "actor-a",
    });
    expect(await redeem({ token, actorId: "actor-b" })).toBeNull();
    // Even the legitimate actor cannot redeem afterwards — wrong-actor lookup
    // burns the entry to prevent retry-after-failed-steal.
    expect(await redeem({ token, actorId: "actor-a" })).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await redeem({ token: "not-a-real-token", actorId: "actor-a" })).toBeNull();
  });

  it("expires entries after the configured TTL", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-05-17T00:00:00Z");
    vi.setSystemTime(start);

    const { token } = await mint({
      plaintext: "hunter2",
      allowedActorId: "actor-a",
      ttlSec: 60,
    });

    vi.setSystemTime(new Date(start.getTime() + 59_000));
    expect(await redeem({ token, actorId: "actor-a" })).toEqual({
      plaintext: "hunter2",
    });

    // Mint a fresh one and let it expire.
    const { token: token2 } = await mint({
      plaintext: "another",
      allowedActorId: "actor-a",
      ttlSec: 60,
    });
    vi.setSystemTime(new Date(start.getTime() + 61_000 + 60_000));
    expect(await redeem({ token: token2, actorId: "actor-a" })).toBeNull();
  });

  it("issues distinct tokens for repeated mints with the same payload", async () => {
    const a = await mint({ plaintext: "x", allowedActorId: "actor-a" });
    const b = await mint({ plaintext: "x", allowedActorId: "actor-a" });
    expect(a.token).not.toBe(b.token);
  });

  it("includes the configured TTL in the response", async () => {
    const { expiresInSec } = await mint({
      plaintext: "x",
      allowedActorId: "actor-a",
      ttlSec: 42,
    });
    expect(expiresInSec).toBe(42);
  });
});
