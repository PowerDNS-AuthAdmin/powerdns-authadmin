/**
 * lib/realtime/event-bus.test.ts
 *
 * The in-process delivery path (no REDIS_URL in tests, so the Redis fan-out is a
 * no-op): subscribe → publish → deliver, type filtering, unsubscribe, and
 * publisher isolation from listener faults.
 */

import { describe, expect, it } from "vitest";
import { publishAuditEvent, publishHealthEvent, publishZoneEvent, subscribeAll } from "./event-bus";

describe("event-bus local delivery", () => {
  it("delivers to subscribers and stops after unsubscribe", () => {
    const seen: string[] = [];
    const unsub = subscribeAll((e) => seen.push(e.type));
    publishZoneEvent({ type: "zone.updated", zone: "z", serverSlug: "s", actor: null, at: "t" });
    publishHealthEvent();
    expect(seen).toEqual(["zone.updated", "health.updated"]);

    unsub();
    publishHealthEvent();
    expect(seen).toEqual(["zone.updated", "health.updated"]); // nothing after unsubscribe
  });

  it("each publisher only emits its own event family", () => {
    const seen: string[] = [];
    const unsub = subscribeAll((e) => seen.push(e.type));
    // A health event handed to the zone publisher is dropped (wrong family).
    publishZoneEvent({ type: "health.updated", at: "t" });
    publishAuditEvent({
      type: "audit.appended",
      action: "zone.create",
      resourceType: "zone",
      resourceId: "z",
      actorId: "u",
      at: "t",
    });
    expect(seen).toEqual(["audit.appended"]);
    unsub();
  });

  it("a faulting listener never breaks delivery to the others", () => {
    const seen: string[] = [];
    const u1 = subscribeAll(() => {
      throw new Error("boom");
    });
    const u2 = subscribeAll((e) => seen.push(e.type));
    publishHealthEvent();
    expect(seen).toEqual(["health.updated"]);
    u1();
    u2();
  });
});
