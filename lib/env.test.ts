import { describe, expect, it } from "vitest";
import {
  BUILD_TIME_PLACEHOLDER_MARK,
  detectBuildTimePlaceholders,
  ENV_KEYS,
  envSchema,
  tokenSetupHintFrom,
} from "./env";

describe("ENV_KEYS coverage", () => {
  // A schema key absent from ENV_KEYS is never read from process.env, so the
  // schema silently applies its default and the variable does nothing at
  // runtime (this regressed SETTINGS_RO once). Keep the two in lockstep.
  it("collects every variable declared in envSchema", () => {
    const schemaKeys = Object.keys(envSchema.shape);
    const collected = new Set<string>(ENV_KEYS);
    const missing = schemaKeys.filter((k) => !collected.has(k));
    expect(missing).toEqual([]);
  });

  it("has no ENV_KEYS entry without a matching schema field", () => {
    const schemaKeys = new Set(Object.keys(envSchema.shape));
    const orphaned = ENV_KEYS.filter((k) => !schemaKeys.has(k));
    expect(orphaned).toEqual([]);
  });
});

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
      // Different user, same host name "build" coincidentally - not the
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

describe("TOKEN_SETUP_HINT_*", () => {
  const hintSchema = envSchema.pick({
    TOKEN_SETUP_HINT_COMMAND: true,
    TOKEN_SETUP_HINT_TEXT: true,
    TOKEN_SETUP_HINT_URL: true,
  });

  it("is off when no command is configured", () => {
    expect(tokenSetupHintFrom(hintSchema.parse({}))).toBeNull();
  });

  it("carries the command, text and link when configured", () => {
    const parsed = hintSchema.parse({
      TOKEN_SETUP_HINT_COMMAND: " acme-setup ",
      TOKEN_SETUP_HINT_TEXT: "Paste just this token when acme-setup asks for it.",
      TOKEN_SETUP_HINT_URL: "https://docs.example.com/setup",
    });
    expect(tokenSetupHintFrom(parsed)).toEqual({
      command: "acme-setup",
      text: "Paste just this token when acme-setup asks for it.",
      url: "https://docs.example.com/setup",
    });
  });

  it("leaves text and link null when only the command is set", () => {
    const parsed = hintSchema.parse({ TOKEN_SETUP_HINT_COMMAND: "acme-setup" });
    expect(tokenSetupHintFrom(parsed)).toEqual({ command: "acme-setup", text: null, url: null });
  });

  it("refuses a link that is not http(s)", () => {
    expect(
      hintSchema.safeParse({
        TOKEN_SETUP_HINT_COMMAND: "acme-setup",
        TOKEN_SETUP_HINT_URL: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("refuses an over-long sentence", () => {
    expect(
      hintSchema.safeParse({
        TOKEN_SETUP_HINT_COMMAND: "acme-setup",
        TOKEN_SETUP_HINT_TEXT: "x".repeat(301),
      }).success,
    ).toBe(false);
  });
});
