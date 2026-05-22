import { describe, expect, it } from "vitest";
import { freshnessOf } from "./freshness";

const NOW = Date.parse("2026-05-17T12:00:00.000Z");

describe("freshnessOf", () => {
  it("returns 'just now' for under a minute", () => {
    expect(freshnessOf("2026-05-17T11:59:30.000Z", NOW)).toEqual({
      label: "just now",
      kind: "fresh",
    });
  });

  it("returns minute precision for under an hour", () => {
    expect(freshnessOf("2026-05-17T11:50:00.000Z", NOW)).toEqual({
      label: "10m ago",
      kind: "fresh",
    });
  });

  it("crosses from fresh to aging at the 1h mark", () => {
    // 59 minutes ago — still fresh (boundary is exclusive).
    expect(freshnessOf("2026-05-17T11:01:00.000Z", NOW).kind).toBe("fresh");
    // Exactly 1 hour ago — flips to aging.
    expect(freshnessOf("2026-05-17T11:00:00.000Z", NOW)).toEqual({
      label: "1h ago",
      kind: "aging",
    });
  });

  it("returns hour precision for under a day", () => {
    expect(freshnessOf("2026-05-17T05:00:00.000Z", NOW)).toEqual({
      label: "7h ago",
      kind: "aging",
    });
  });

  it("crosses from aging to stale at the 24h mark", () => {
    expect(freshnessOf("2026-05-16T13:00:00.000Z", NOW).kind).toBe("aging");
    expect(freshnessOf("2026-05-16T11:59:00.000Z", NOW)).toEqual({
      label: "1d ago",
      kind: "stale",
    });
  });

  it("returns day precision for stale entries", () => {
    expect(freshnessOf("2026-05-10T12:00:00.000Z", NOW)).toEqual({
      label: "7d ago",
      kind: "stale",
    });
  });

  it("handles a malformed timestamp by returning stale + unknown", () => {
    expect(freshnessOf("not-a-date", NOW)).toEqual({ label: "unknown", kind: "stale" });
  });

  it("handles future timestamps as just-now (clock skew)", () => {
    // Operator's clock skew vs server's clock skew shouldn't crash;
    // negative ages clamp to zero → "just now".
    expect(freshnessOf("2026-05-17T12:00:30.000Z", NOW)).toEqual({
      label: "just now",
      kind: "fresh",
    });
  });
});
