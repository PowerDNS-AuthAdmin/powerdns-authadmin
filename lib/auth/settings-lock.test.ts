/**
 * lib/auth/settings-lock.test.ts
 *
 * The Settings RO lock is a pure decision (env flag → allow/deny), so it's
 * unit-tested in isolation. The route handler that calls it maps the thrown
 * ForbiddenError to a 403 via the shared error-response layer — that mapping is
 * covered once in lib/errors; here we only assert the decision itself.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

// Mutable mock env — `mock`-prefixed so vitest's hoisting allows the factory to
// close over it. Each test sets the one field it cares about in beforeEach.
const mockEnv: { SETTINGS_RO: boolean } = { SETTINGS_RO: false };

vi.mock("@/lib/env", () => ({ env: mockEnv }));

const { isSettingsReadOnly, assertSettingsMutable } = await import("./settings-lock");

beforeEach(() => {
  mockEnv.SETTINGS_RO = false;
});

describe("isSettingsReadOnly", () => {
  it("is false by default (lock off)", () => {
    expect(isSettingsReadOnly()).toBe(false);
  });

  it("is true when the lock is on", () => {
    mockEnv.SETTINGS_RO = true;
    expect(isSettingsReadOnly()).toBe(true);
  });
});

describe("assertSettingsMutable", () => {
  it("does not throw when the lock is off", () => {
    mockEnv.SETTINGS_RO = false;
    expect(() => assertSettingsMutable()).not.toThrow();
  });

  it("throws ForbiddenError when the lock is on", () => {
    mockEnv.SETTINGS_RO = true;
    expect(() => assertSettingsMutable()).toThrow(ForbiddenError);
  });
});
