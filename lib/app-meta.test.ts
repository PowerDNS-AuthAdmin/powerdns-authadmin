import { afterEach, describe, expect, it, vi } from "vitest";

// app-meta reads the build env at module load, so each case stubs the env and
// re-imports a fresh module copy.
async function loadFresh() {
  vi.resetModules();
  return import("./app-meta");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("app-meta", () => {
  it("release build (APP_RELEASE=true): clean version + tag-pinned links", async () => {
    vi.stubEnv("APP_RELEASE", "true");
    vi.stubEnv("APP_GIT_SHA", "abc1234def5678"); // present but ignored for releases
    const m = await loadFresh();

    expect(m.IS_RELEASE_BUILD).toBe(true);
    expect(m.APP_VERSION_LABEL).toBe(m.APP_VERSION);
    expect(m.APP_SOURCE_URL).toBe(
      `https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/releases/tag/v${m.APP_VERSION}`,
    );
    expect(m.APP_DOCS_URL).toBe(
      `https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/tree/v${m.APP_VERSION}/docs`,
    );
  });

  it("non-release build with a SHA: version+sha label + commit/docs links", async () => {
    vi.stubEnv("APP_RELEASE", "false");
    vi.stubEnv("APP_GIT_SHA", "abc1234def5678");
    const m = await loadFresh();

    expect(m.IS_RELEASE_BUILD).toBe(false);
    expect(m.APP_GIT_SHA).toBe("abc1234"); // truncated to 7
    expect(m.APP_VERSION_LABEL).toBe(`${m.APP_VERSION}+abc1234`);
    expect(m.APP_SOURCE_URL).toMatch(/\/commit\/abc1234$/);
    expect(m.APP_DOCS_URL).toMatch(/\/tree\/abc1234\/docs$/);
  });

  it("local/dev build (no SHA, not a release): -dev label + main-branch links", async () => {
    vi.stubEnv("APP_RELEASE", "");
    vi.stubEnv("APP_GIT_SHA", "");
    const m = await loadFresh();

    // Not a release: a dev build must not masquerade as one.
    expect(m.IS_RELEASE_BUILD).toBe(false);
    expect(m.APP_GIT_SHA).toBeNull();
    expect(m.APP_VERSION_LABEL).toBe(`${m.APP_VERSION}-dev`);
    // No commit ref exists on the remote, so link to `main`, not a 404 commit.
    expect(m.APP_SOURCE_URL).toBe(
      "https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/tree/main",
    );
    expect(m.APP_DOCS_URL).toBe(
      "https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/tree/main/docs",
    );
    expect(m.APP_SOURCE_TITLE).toContain("local build");
  });
});
