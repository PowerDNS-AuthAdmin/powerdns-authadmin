import { describe, expect, it } from "vitest";
import { describeFlash } from "./flash-listener";

describe("describeFlash", () => {
  it("returns null for unknown flash kinds", () => {
    expect(describeFlash("nope", null)).toBeNull();
    expect(describeFlash("", null)).toBeNull();
  });

  it("maps forbidden → error toast, with optional need", () => {
    expect(describeFlash("forbidden", null)?.kind).toBe("error");
    expect(describeFlash("forbidden", "zone.read")?.description).toContain("zone.read");
  });

  it("maps session-required → info", () => {
    expect(describeFlash("session-required", null)?.kind).toBe("info");
  });

  // v1.2.0 - the polling-required flash redirect surface.
  describe("polling-required", () => {
    it("is a red error toast", () => {
      expect(describeFlash("polling-required", null)?.kind).toBe("error");
    });

    it("names the env var verbatim so the operator can grep for it", () => {
      // The env var name must appear so an operator can copy it straight into
      // their .env / docker-compose.yml. Don't soften this string.
      const got = describeFlash("polling-required", null);
      expect(got?.description).toContain("PDNS_BACKGROUND_POLLING=true");
    });

    it("interpolates the `need` parameter when given (which feature was hit)", () => {
      const got = describeFlash("polling-required", "per-zone Sync");
      expect(got?.description).toContain("per-zone Sync");
      expect(got?.description).toContain("PDNS_BACKGROUND_POLLING=true");
    });

    it("still names the env var even without a `need` param", () => {
      // Bare ?flash=polling-required (no need=...) must still surface the var.
      expect(describeFlash("polling-required", null)?.description).toContain(
        "PDNS_BACKGROUND_POLLING=true",
      );
    });
  });
});
