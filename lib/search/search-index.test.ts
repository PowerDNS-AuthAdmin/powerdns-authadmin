import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const published: number[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishSearchIndexEvent: (version: number) => published.push(version),
  subscribeAll: () => () => undefined,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: () => undefined } }));

import type { SearchSources } from "./index";
import {
  getSearchSnapshot,
  rebuildSearchIndexNow,
  resetSearchIndexForTests,
  snapshotSources,
} from "./search-index";

function sourcesWith(zoneNames: () => string[], fail = { on: false }): SearchSources {
  const none = () => Promise.resolve([]);
  return {
    zones: () =>
      fail.on
        ? Promise.reject(new Error("backend down"))
        : Promise.resolve(
            zoneNames().map((name) => ({
              name,
              serverId: "s",
              serverSlug: "s",
              serverName: "S",
              clusterSlug: null,
              horizon: "public",
              kind: "Native",
            })),
          ),
    records: none,
    settings: none,
    backends: none,
    clusters: none,
    users: none,
    teams: none,
    roles: none,
    templates: none,
    authProviders: none,
    requests: none,
    audit: none,
  };
}

describe("search index", () => {
  beforeEach(() => {
    published.length = 0;
  });
  afterEach(() => resetSearchIndexForTests(null));

  it("builds once on first use and serves the same snapshot until a rebuild swaps it", async () => {
    let names = ["a.example."];
    const loads = vi.fn(() => names);
    resetSearchIndexForTests(sourcesWith(loads));

    const first = await getSearchSnapshot();
    expect(first.version).toBe(1);
    expect(await getSearchSnapshot()).toBe(first);
    expect(loads).toHaveBeenCalledTimes(1);

    names = ["a.example.", "b.example."];
    const second = await rebuildSearchIndexNow();
    expect(second?.version).toBe(2);
    expect(await getSearchSnapshot()).toBe(second);
    // The old snapshot is untouched: a query that started on it finishes consistently.
    expect(first.data.zones.map((z) => z.name)).toEqual(["a.example."]);
    expect((await snapshotSources(second!).zones()).map((z) => z.name)).toEqual([
      "a.example.",
      "b.example.",
    ]);
    expect(published).toEqual([1, 2]);
  });

  it("keeps serving the last good snapshot when a rebuild fails", async () => {
    const fail = { on: false };
    resetSearchIndexForTests(sourcesWith(() => ["a.example."], fail));
    const good = await getSearchSnapshot();
    fail.on = true;
    expect(await rebuildSearchIndexNow()).toBe(good);
    expect(await getSearchSnapshot()).toBe(good);
    expect(published).toEqual([1]);
  });

  it("shares one build between concurrent first queries", async () => {
    const loads = vi.fn(() => ["a.example."]);
    resetSearchIndexForTests(sourcesWith(loads));
    const [a, b] = await Promise.all([getSearchSnapshot(), getSearchSnapshot()]);
    expect(a).toBe(b);
    expect(loads).toHaveBeenCalledTimes(1);
  });
});
