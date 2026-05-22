import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./audit-like";

describe("escapeLikePattern", () => {
  it("returns plain ASCII unchanged", () => {
    expect(escapeLikePattern("user@example.com")).toBe("user@example.com");
    expect(escapeLikePattern("auth.login.success")).toBe("auth.login.success");
  });

  it("escapes the literal percent character", () => {
    // Without escaping, "100%" would match ANY row when wrapped in ILIKE patterns.
    expect(escapeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes the literal underscore character", () => {
    // Without escaping, "user_id" would match "userXid" / "userZid" / etc.
    expect(escapeLikePattern("user_id")).toBe("user\\_id");
  });

  it("escapes backslash first to avoid double-escaping the literals it inserts", () => {
    // A literal backslash in the input must become two backslashes
    // BEFORE we add new backslashes for % and _. Otherwise the
    // backslash before the `%` escape would itself get escaped into
    // four backslashes by the next pass.
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("a\\%b")).toBe("a\\\\\\%b");
  });

  it("handles empty input", () => {
    expect(escapeLikePattern("")).toBe("");
  });

  it("handles strings with all three metacharacters", () => {
    expect(escapeLikePattern("100%_done\\maybe")).toBe("100\\%\\_done\\\\maybe");
  });
});
