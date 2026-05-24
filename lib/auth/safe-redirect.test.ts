/**
 * lib/auth/safe-redirect.test.ts
 *
 * The open-redirect guard for the post-auth `?next=` destination (L-2).
 */

import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("returns a same-origin relative path unchanged", () => {
    expect(safeNextPath("/zones")).toBe("/zones");
    expect(safeNextPath("/zones/example.com.?tab=metadata")).toBe(
      "/zones/example.com.?tab=metadata",
    );
    expect(safeNextPath("/admin/servers/abc")).toBe("/admin/servers/abc");
  });

  it("falls back to /dashboard for empty/missing input", () => {
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("rejects absolute and protocol-relative URLs (open-redirect defense)", () => {
    expect(safeNextPath("https://evil.example/")).toBe("/dashboard");
    expect(safeNextPath("http://evil.example/")).toBe("/dashboard");
    expect(safeNextPath("//evil.example/")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it("never bounces back to the auth routes", () => {
    expect(safeNextPath("/login")).toBe("/dashboard");
    expect(safeNextPath("/login?next=/x")).toBe("/dashboard");
    expect(safeNextPath("/login/whatever")).toBe("/dashboard");
  });
});
