import { describe, expect, it } from "vitest";
import { BUILD_TIME_PLACEHOLDER_MARK, detectBuildTimePlaceholders } from "./env";

const realLooking = {
  APP_SECRET_KEY: "Z".repeat(48),
  APP_ENCRYPTION_KEY: "Y".repeat(48),
  DATABASE_URL: "postgres://app:hunter2@db.internal/app",
};

const placeholderSecret = `${BUILD_TIME_PLACEHOLDER_MARK}-not-used-at-runtime-please-do-not-deploy`;
const placeholderDbUrl = "postgres://build:build@localhost:5432/build";

describe("detectBuildTimePlaceholders", () => {
  it("returns no violations during the build phase even with placeholders", () => {
    const v = detectBuildTimePlaceholders({
      APP_SECRET_KEY: placeholderSecret,
      APP_ENCRYPTION_KEY: placeholderSecret,
      DATABASE_URL: placeholderDbUrl,
      isBuildPhase: true,
    });
    expect(v).toEqual([]);
  });

  it("returns no violations at runtime when env looks real", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      isBuildPhase: false,
    });
    expect(v).toEqual([]);
  });

  it("flags APP_SECRET_KEY when the marker is present at runtime", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      APP_SECRET_KEY: placeholderSecret,
      isBuildPhase: false,
    });
    expect(v).toEqual(["APP_SECRET_KEY"]);
  });

  it("flags APP_ENCRYPTION_KEY when the marker is present at runtime", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      APP_ENCRYPTION_KEY: placeholderSecret,
      isBuildPhase: false,
    });
    expect(v).toEqual(["APP_ENCRYPTION_KEY"]);
  });

  it("flags DATABASE_URL when the build:build@ placeholder is present at runtime", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      DATABASE_URL: placeholderDbUrl,
      isBuildPhase: false,
    });
    expect(v).toEqual(["DATABASE_URL"]);
  });

  it("returns all affected keys when multiple placeholders leak", () => {
    const v = detectBuildTimePlaceholders({
      APP_SECRET_KEY: placeholderSecret,
      APP_ENCRYPTION_KEY: placeholderSecret,
      DATABASE_URL: placeholderDbUrl,
      isBuildPhase: false,
    });
    expect(v).toEqual(["APP_SECRET_KEY", "APP_ENCRYPTION_KEY", "DATABASE_URL"]);
  });

  it("does NOT false-positive on a real DATABASE_URL with a non-placeholder user", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      // Different user, same host name "build" coincidentally — not the
      // placeholder shape.
      DATABASE_URL: "postgres://realuser:realpass@build.example/app",
      isBuildPhase: false,
    });
    expect(v).toEqual([]);
  });

  it("matches the marker even with extra surrounding text", () => {
    const v = detectBuildTimePlaceholders({
      ...realLooking,
      APP_SECRET_KEY: `prefix-${BUILD_TIME_PLACEHOLDER_MARK}-suffix-padded`,
      isBuildPhase: false,
    });
    expect(v).toEqual(["APP_SECRET_KEY"]);
  });
});
