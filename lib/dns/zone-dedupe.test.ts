import { describe, expect, it } from "vitest";
import { dedupeZonesByIdentity, zoneIdentityKey } from "./zone-dedupe";
import type { DedupableZoneRow } from "./zone-dedupe";

interface Row extends DedupableZoneRow {
  backend: string;
}

const row = (
  backend: string,
  name: string,
  opts: { horizon?: Row["horizon"]; readOnly?: boolean } = {},
): Row => ({
  backend,
  name,
  horizon: opts.horizon ?? "public",
  ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
});

describe("zoneIdentityKey", () => {
  it("separates the same name on different horizons", () => {
    expect(zoneIdentityKey(row("a", "ngn.au.", { horizon: "internal" }))).not.toBe(
      zoneIdentityKey(row("b", "ngn.au.")),
    );
  });

  it("is equal for the same (horizon, name) regardless of source backend", () => {
    expect(zoneIdentityKey(row("a", "ngn.au."))).toBe(zoneIdentityKey(row("b", "ngn.au.")));
  });
});

describe("dedupeZonesByIdentity", () => {
  it("collapses the same name on the same horizon", () => {
    const { kept, hidden } = dedupeZonesByIdentity([
      row("primary", "example.com."),
      row("other-primary", "example.com."),
    ]);
    expect(kept.map((r) => r.backend)).toEqual(["primary"]);
    expect(hidden.map((r) => r.backend)).toEqual(["other-primary"]);
  });

  // #121 - the whole point. An internal zone is a different zone from the
  // public one that happens to share its name, so both must list.
  it("keeps an internal and a public copy of the same name as separate rows", () => {
    const { kept, hidden } = dedupeZonesByIdentity([
      row("public-ns", "ngn.au."),
      row("internal-ns", "ngn.au.", { horizon: "internal" }),
    ]);
    expect(kept.map((r) => r.backend)).toEqual(["public-ns", "internal-ns"]);
    expect(hidden).toEqual([]);
  });

  it("still collapses two internal copies of one name", () => {
    const { kept, hidden } = dedupeZonesByIdentity([
      row("internal-a", "ngn.au.", { horizon: "internal" }),
      row("internal-b", "ngn.au.", { horizon: "internal" }),
    ]);
    expect(kept).toHaveLength(1);
    expect(hidden.map((r) => r.backend)).toEqual(["internal-b"]);
  });

  it("prefers an authoritative row over a read-only mirror, whichever arrives first", () => {
    const mirrorFirst = dedupeZonesByIdentity([
      row("mirror", "example.com.", { readOnly: true }),
      row("primary", "example.com."),
    ]);
    expect(mirrorFirst.kept.map((r) => r.backend)).toEqual(["primary"]);
    expect(mirrorFirst.hidden.map((r) => r.backend)).toEqual(["mirror"]);

    const primaryFirst = dedupeZonesByIdentity([
      row("primary", "example.com."),
      row("mirror", "example.com.", { readOnly: true }),
    ]);
    expect(primaryFirst.kept.map((r) => r.backend)).toEqual(["primary"]);
    expect(primaryFirst.hidden.map((r) => r.backend)).toEqual(["mirror"]);
  });

  it("keeps a displaced row's original list position", () => {
    // The mirror of b. arrives first, so b. sits in the middle; promoting the
    // primary must not move it to the end.
    const { kept } = dedupeZonesByIdentity([
      row("x", "a."),
      row("mirror", "b.", { readOnly: true }),
      row("y", "c."),
      row("primary", "b."),
    ]);
    expect(kept.map((r) => r.name)).toEqual(["a.", "b.", "c."]);
    expect(kept[1]?.backend).toBe("primary");
  });

  it("keeps the first of two mirrors when no primary serves the zone", () => {
    const { kept, hidden } = dedupeZonesByIdentity([
      row("mirror-a", "example.com.", { readOnly: true }),
      row("mirror-b", "example.com.", { readOnly: true }),
    ]);
    expect(kept.map((r) => r.backend)).toEqual(["mirror-a"]);
    expect(hidden.map((r) => r.backend)).toEqual(["mirror-b"]);
  });

  it("passes an empty list through", () => {
    expect(dedupeZonesByIdentity([])).toEqual({ kept: [], hidden: [] });
  });
});
