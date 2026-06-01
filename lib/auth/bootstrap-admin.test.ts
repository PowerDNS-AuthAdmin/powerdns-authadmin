/**
 * lib/auth/bootstrap-admin.test.ts
 *
 * The RO identity lock is a pure decision (env + email → allow/deny), so it's
 * unit-tested in isolation. The route handlers that call it map the thrown
 * ForbiddenError to a 403 via the shared error-response layer — that mapping is
 * covered once in lib/errors; here we only assert the decision itself.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

// Mutable mock env — `mock`-prefixed so vitest's hoisting allows the factory to
// close over it. Each test sets the two fields it cares about in beforeEach.
const mockEnv: { BOOTSTRAP_ADMIN_RO: boolean; BOOTSTRAP_ADMIN_EMAIL: string | undefined } = {
  BOOTSTRAP_ADMIN_RO: false,
  BOOTSTRAP_ADMIN_EMAIL: undefined,
};

vi.mock("@/lib/env", () => ({ env: mockEnv }));

const { isBootstrapAdminLocked, assertBootstrapAdminMutable } = await import("./bootstrap-admin");

beforeEach(() => {
  mockEnv.BOOTSTRAP_ADMIN_RO = false;
  mockEnv.BOOTSTRAP_ADMIN_EMAIL = undefined;
});

describe("isBootstrapAdminLocked", () => {
  it("is false when the RO flag is off, even for the bootstrap email", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = false;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(isBootstrapAdminLocked("admin@example.com")).toBe(false);
  });

  it("is false when RO is on but no bootstrap email is configured", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = undefined;
    expect(isBootstrapAdminLocked("admin@example.com")).toBe(false);
  });

  it("is true for the matching bootstrap email when RO is on", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(isBootstrapAdminLocked("admin@example.com")).toBe(true);
  });

  it("matches case-insensitively on both sides", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "Admin@Example.com";
    expect(isBootstrapAdminLocked("ADMIN@example.COM")).toBe(true);
  });

  it("is false for a different user even when RO is on", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(isBootstrapAdminLocked("someone-else@example.com")).toBe(false);
  });

  it("is false for null / undefined / empty email", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(isBootstrapAdminLocked(null)).toBe(false);
    expect(isBootstrapAdminLocked(undefined)).toBe(false);
    expect(isBootstrapAdminLocked("")).toBe(false);
  });
});

describe("assertBootstrapAdminMutable", () => {
  it("throws ForbiddenError for the locked bootstrap admin", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(() => assertBootstrapAdminMutable("admin@example.com")).toThrow(ForbiddenError);
  });

  it("does not throw when the lock is off", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = false;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(() => assertBootstrapAdminMutable("admin@example.com")).not.toThrow();
  });

  it("does not throw for a non-bootstrap user", () => {
    mockEnv.BOOTSTRAP_ADMIN_RO = true;
    mockEnv.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    expect(() => assertBootstrapAdminMutable("other@example.com")).not.toThrow();
  });
});
