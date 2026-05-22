/**
 * lib/pdns/client.test.ts — zone-id normalization + HTTP integration sketch.
 *
 * Full transport behavior (retries, timeouts) is exercised in the integration
 * suite under `tests/integration/` where a fake PDNS is available; here we
 * cover the deterministic helpers that don't need the network.
 */

import { describe, expect, it } from "vitest";
import { normalizeZoneId } from "./client";

describe("normalizeZoneId", () => {
  it("adds a trailing dot when missing", () => {
    expect(normalizeZoneId("example.com")).toBe("example.com.");
  });

  it("leaves a trailing dot alone", () => {
    expect(normalizeZoneId("example.com.")).toBe("example.com.");
  });

  it("lowercases", () => {
    expect(normalizeZoneId("Example.COM")).toBe("example.com.");
  });

  it("trims whitespace", () => {
    expect(normalizeZoneId("  example.com  ")).toBe("example.com.");
  });

  it("returns empty for empty input", () => {
    expect(normalizeZoneId("")).toBe("");
    expect(normalizeZoneId("   ")).toBe("");
  });
});
