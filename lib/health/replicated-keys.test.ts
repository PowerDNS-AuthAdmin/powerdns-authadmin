import { describe, expect, it } from "vitest";
import { missingReplicatedKeys } from "./replicated-keys";

describe("missingReplicatedKeys", () => {
  it("flags a secondary missing a key the primary replicated to the group", () => {
    // k1 is on the primary + sec-a (so it's 'replicated'); sec-b deleted it.
    const out = missingReplicatedKeys(
      ["k1", "k2"],
      [
        { id: "sec-a", names: ["k1", "k2"] },
        { id: "sec-b", names: ["k2"] },
      ],
    );
    expect(out.get("sec-b")).toBe(1);
    expect(out.has("sec-a")).toBe(false);
  });

  it("does NOT flag primary-only keys (never replicated)", () => {
    // k-local lives only on the primary — not pushed to any secondary, so absent
    // there is fine. k-shared is replicated and present on both → nothing missing.
    const out = missingReplicatedKeys(
      ["k-local", "k-shared"],
      [
        { id: "sec-a", names: ["k-shared"] },
        { id: "sec-b", names: ["k-shared"] },
      ],
    );
    expect(out.size).toBe(0);
  });

  it("skips a secondary that wasn't enumerated (null) rather than flagging it", () => {
    const out = missingReplicatedKeys(
      ["k1"],
      [
        { id: "sec-a", names: ["k1"] }, // makes k1 'replicated'
        { id: "sec-b", names: null }, // unreachable / old version
      ],
    );
    expect(out.has("sec-b")).toBe(false);
  });

  it("counts multiple missing replicated keys on one secondary", () => {
    const out = missingReplicatedKeys(
      ["k1", "k2", "k3"],
      [
        { id: "sec-a", names: ["k1", "k2", "k3"] },
        { id: "sec-b", names: ["k1"] },
      ],
    );
    expect(out.get("sec-b")).toBe(2);
  });

  it("returns empty when the primary has no keys or there are no secondaries", () => {
    expect(missingReplicatedKeys([], [{ id: "sec-a", names: [] }]).size).toBe(0);
    expect(missingReplicatedKeys(null, [{ id: "sec-a", names: [] }]).size).toBe(0);
    expect(missingReplicatedKeys(["k1"], []).size).toBe(0);
  });
});
