/**
 * lib/realtime/event-bus-redis.test.ts
 *
 * The Redis cross-replica fan-out path (ADR-0016), with `@/lib/redis` stubbed so
 * no real connection is opened. Regression cover for issue #4: a transient
 * `subscribe()` failure resets `redisSubscribed` to permit a retry, and the
 * earlier code re-attached the `message` handler on every retry - so each Redis
 * blip permanently added another listener and remote events fanned out N+1×.
 * The handler must register EXACTLY ONCE for the subscriber's lifetime.
 *
 * The bus state is a `globalThis` singleton, so we reset both it and the module
 * registry between cases to start each test from a clean subscriber.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal stand-in for the ioredis subscriber. `subscribe` is programmable per
// call (reject then resolve, to simulate a transient outage that later heals);
// `on` is a spy so we can count `message` registrations.
type SubscribeImpl = () => Promise<unknown>;
function makeFakeSubscriber() {
  let nextSubscribe: SubscribeImpl = () => Promise.resolve("ok");
  const on = vi.fn();
  const handlersFor = (eventName: string) => on.mock.calls.filter(([name]) => name === eventName);
  return {
    sub: {
      subscribe: vi.fn(() => nextSubscribe()),
      on,
    },
    on,
    handlersFor,
    setNextSubscribe(impl: SubscribeImpl) {
      nextSubscribe = impl;
    },
  };
}

let fake = makeFakeSubscriber();
let redisEnabled = true;

vi.mock("@/lib/redis", () => ({
  isRedisEnabled: () => redisEnabled,
  getRedis: () => null,
  getRedisSubscriber: () => fake.sub,
}));

beforeEach(() => {
  fake = makeFakeSubscriber();
  redisEnabled = true;
  // The bus is `globalThis.__pdnsRealtimeBus ??= {...}`; drop it so a fresh
  // re-import rebuilds it (incl. the redisHandlerAttached latch).
  delete (globalThis as { __pdnsRealtimeBus?: unknown }).__pdnsRealtimeBus;
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { __pdnsRealtimeBus?: unknown }).__pdnsRealtimeBus;
});

// ensureRedisSubscription is internal; subscribeAll is the only caller and runs
// it on every call, so we drive it through subscribeAll.
async function loadBus() {
  return import("./event-bus");
}

// A subscriber whose deliveries we don't inspect (the subscribe/handler-attach
// machinery is what these cases assert, not fan-out).
const noop = (): void => undefined;

describe("event-bus Redis subscription (issue #4)", () => {
  it("registers the message handler exactly once across subscribe failures then success", async () => {
    const { subscribeAll } = await loadBus();

    // 1st attempt: subscribe rejects → redisSubscribed resets to allow a retry.
    fake.setNextSubscribe(() => Promise.reject(new Error("redis down")));
    subscribeAll(noop)();
    await Promise.resolve(); // let the rejection .catch run

    // 2nd attempt: still failing.
    fake.setNextSubscribe(() => Promise.reject(new Error("still down")));
    subscribeAll(noop)();
    await Promise.resolve();

    // 3rd attempt: Redis heals.
    fake.setNextSubscribe(() => Promise.resolve("ok"));
    subscribeAll(noop)();
    await Promise.resolve();

    // Subscribe was retried each time the flag had reset...
    expect(fake.sub.subscribe).toHaveBeenCalledTimes(3);
    // ...but the message handler was attached only once.
    expect(fake.handlersFor("message")).toHaveLength(1);
  });

  it("does not re-attach the handler when already subscribed", async () => {
    const { subscribeAll } = await loadBus();

    subscribeAll(noop)(); // subscribes (success)
    await Promise.resolve();
    subscribeAll(noop)(); // guarded out by redisSubscribed
    subscribeAll(noop)();

    expect(fake.sub.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.handlersFor("message")).toHaveLength(1);
  });

  it("delivers remote events once but skips its own instance's republish", async () => {
    const { subscribeAll } = await loadBus();

    const seen: string[] = [];
    subscribeAll((e) => seen.push(e.type));
    await Promise.resolve();

    const handler = fake.handlersFor("message")[0]?.[1] as (
      channel: string,
      message: string,
    ) => void;
    expect(handler).toBeTypeOf("function");

    const remote = {
      instanceId: "some-other-replica",
      event: { type: "health.updated", at: "t" },
    };
    // Wrong channel: ignored.
    handler("other:channel", JSON.stringify(remote));
    // Right channel, remote instance: delivered exactly once.
    handler("pda:realtime", JSON.stringify(remote));
    // Malformed payload: swallowed, no throw.
    handler("pda:realtime", "{not json");

    expect(seen).toEqual(["health.updated"]);
  });

  it("skips a republish tagged with this instance's own id", async () => {
    // getRedis is mocked to null, so emit's Redis publish is a no-op and the
    // private instanceId never leaves the module. We assert the self-skip via the
    // id the bus puts on its own outbound payloads: capture it by re-enabling
    // getRedis to a recording publisher.
    const published: string[] = [];
    vi.doMock("@/lib/redis", () => ({
      isRedisEnabled: () => true,
      getRedis: () => ({
        publish: (_ch: string, payload: string) => {
          published.push(payload);
          return Promise.resolve(1);
        },
      }),
      getRedisSubscriber: () => fake.sub,
    }));
    const { subscribeAll, publishHealthEvent } = await import("./event-bus");

    const seen: string[] = [];
    subscribeAll((e) => seen.push(e.type));
    await Promise.resolve();

    const handler = fake.handlersFor("message")[0]?.[1] as (
      channel: string,
      message: string,
    ) => void;

    publishHealthEvent(); // one local delivery + one recorded Redis publish
    const selfPayload = published[0]!;
    const ourId = (JSON.parse(selfPayload) as { instanceId: string }).instanceId;

    // Redis loops our own publish back to us → must be skipped (no duplicate).
    handler(
      "pda:realtime",
      JSON.stringify({ instanceId: ourId, event: { type: "health.updated", at: "t" } }),
    );
    // A genuinely remote event with a different id IS delivered.
    handler(
      "pda:realtime",
      JSON.stringify({ instanceId: "remote", event: { type: "health.updated", at: "t" } }),
    );

    expect(seen).toEqual(["health.updated", "health.updated"]);
  });
});
