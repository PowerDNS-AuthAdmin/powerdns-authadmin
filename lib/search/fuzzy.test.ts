import { describe, expect, it } from "vitest";
import { rankCandidates, scoreMatch } from "./fuzzy";

const highlighted = (text: string, ranges: ReadonlyArray<readonly [number, number]>): string =>
  ranges.map(([s, e]) => text.slice(s, e)).join("|");

describe("scoreMatch", () => {
  it("matches a case-insensitive subsequence and reports merged ranges", () => {
    const m = scoreMatch("EXC", "example.com");
    expect(m).not.toBeNull();
    expect(highlighted("example.com", m!.ranges)).toBe("ex|c");
  });

  it("returns null when a character is missing or out of order", () => {
    expect(scoreMatch("xz", "example.com")).toBeNull();
    expect(scoreMatch("moc", "example.com")).toBeNull();
  });

  it("returns null for an empty query or empty text", () => {
    expect(scoreMatch("", "example.com")).toBeNull();
    expect(scoreMatch("   ", "example.com")).toBeNull();
    expect(scoreMatch("a", "")).toBeNull();
  });

  it("prefers a contiguous run over scattered letters", () => {
    const m = scoreMatch("ample", "example.com")!;
    expect(m.ranges).toEqual([[2, 7]]);
  });

  it("ranks a prefix above a mid-word hit", () => {
    const prefix = scoreMatch("ex", "example.com")!;
    const middle = scoreMatch("ex", "apex-zone.com")!;
    expect(prefix.score).toBeGreaterThan(middle.score);
  });

  it("rewards word boundaries after . - _ space @ /", () => {
    for (const sep of [".", "-", "_", " ", "@", "/"]) {
      const boundary = scoreMatch("mail", `x${sep}mail`)!;
      const inside = scoreMatch("mail", "xxmail")!;
      expect(boundary.score, `separator ${JSON.stringify(sep)}`).toBeGreaterThan(inside.score);
    }
  });

  it("picks the boundary occurrence of a repeated substring", () => {
    const m = scoreMatch("com", "income.com")!;
    expect(m.ranges).toEqual([[7, 10]]);
  });

  it("gives an exact match the top score", () => {
    const exact = scoreMatch("example.com", "example.com")!;
    const longer = scoreMatch("example.com", "example.com.au")!;
    expect(exact.score).toBeGreaterThan(longer.score);
  });

  it("requires every whitespace-separated token", () => {
    expect(scoreMatch("www exa", "www.example.com")).not.toBeNull();
    expect(scoreMatch("www zzz", "www.example.com")).toBeNull();
  });

  it("drops over-spread matches when maxSpreadFactor is set", () => {
    const txt = "v=spf1 include:_spf.google.com include:mailgun.org ~all";
    expect(scoreMatch("vgl", txt)).not.toBeNull();
    expect(scoreMatch("vgl", txt, { maxSpreadFactor: 2 })).toBeNull();
    expect(scoreMatch("mailgun", txt, { maxSpreadFactor: 2 })).not.toBeNull();
  });
});

describe("rankCandidates", () => {
  const zones = ["an-example.net.", "example.com.", "examples.org.", "other.io."];

  it("orders the best match first and drops non-matches", () => {
    const ranked = rankCandidates("example", zones, (z) => z);
    expect(ranked.map((r) => r.item)).toEqual(["example.com.", "examples.org.", "an-example.net."]);
  });

  it("honours the limit", () => {
    expect(rankCandidates("e", zones, (z) => z, { limit: 2 })).toHaveLength(2);
  });

  it("breaks ties on length then alphabetically, so order is stable", () => {
    const ranked = rankCandidates("a", ["ab", "aa", "abc"], (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(["aa", "ab", "abc"]);
  });
});
