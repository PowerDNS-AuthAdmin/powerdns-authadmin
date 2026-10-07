import { describe, expect, it } from "vitest";
import {
  extendTypeaheadBuffer,
  filterOptionIndexes,
  findTypeaheadIndex,
  isTypeaheadKey,
  moveIndex,
  TYPEAHEAD_TIMEOUT_MS,
} from "./select-menu-keys";

const TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "SRV",
  "TXT",
  "CAA",
  "DS",
  "SSHFP",
  "TLSA",
  "NAPTR",
].map((label) => ({ label }));

const idx = (label: string) => TYPES.findIndex((o) => o.label === label);

describe("findTypeaheadIndex", () => {
  it("jumps to the first option starting with the typed letter", () => {
    expect(findTypeaheadIndex(TYPES, "t", -1)).toBe(idx("TXT"));
    expect(findTypeaheadIndex(TYPES, "T", -1)).toBe(idx("TXT"));
  });

  it("cycles through options sharing a first letter on repeated presses", () => {
    const first = findTypeaheadIndex(TYPES, "t", -1);
    expect(first).toBe(idx("TXT"));
    const second = findTypeaheadIndex(TYPES, "tt", first);
    expect(second).toBe(idx("TLSA"));
    // Wraps back around.
    expect(findTypeaheadIndex(TYPES, "ttt", second)).toBe(idx("TXT"));
  });

  it("refines a multi-letter prefix without skipping the current match", () => {
    const t = findTypeaheadIndex(TYPES, "t", -1); // TXT
    expect(findTypeaheadIndex(TYPES, "tl", t)).toBe(idx("TLSA"));
    const s = findTypeaheadIndex(TYPES, "s", -1); // SRV
    expect(findTypeaheadIndex(TYPES, "ss", s)).toBe(idx("SSHFP")); // repeat → next S
    expect(findTypeaheadIndex(TYPES, "sr", idx("SRV"))).toBe(idx("SRV")); // refine → stays
  });

  it("returns -1 when nothing matches or the buffer is empty", () => {
    expect(findTypeaheadIndex(TYPES, "z", -1)).toBe(-1);
    expect(findTypeaheadIndex(TYPES, "", 3)).toBe(-1);
    expect(findTypeaheadIndex([], "a", -1)).toBe(-1);
  });

  it("searches forward from the active option and wraps", () => {
    expect(findTypeaheadIndex(TYPES, "a", idx("A"))).toBe(idx("AAAA"));
    expect(findTypeaheadIndex(TYPES, "a", idx("AAAA"))).toBe(idx("A"));
  });
});

describe("extendTypeaheadBuffer", () => {
  it("appends quick keystrokes and resets stale ones", () => {
    const a = extendTypeaheadBuffer({ text: "", at: 0 }, "t", 1000);
    expect(a.text).toBe("t");
    const b = extendTypeaheadBuffer(a, "l", 1000 + TYPEAHEAD_TIMEOUT_MS - 1);
    expect(b.text).toBe("tl");
    const c = extendTypeaheadBuffer(b, "m", b.at + TYPEAHEAD_TIMEOUT_MS + 1);
    expect(c.text).toBe("m");
  });
});

describe("isTypeaheadKey", () => {
  const none = { ctrl: false, meta: false, alt: false };
  it("accepts single printable characters only", () => {
    expect(isTypeaheadKey("t", none)).toBe(true);
    expect(isTypeaheadKey("7", none)).toBe(true);
    expect(isTypeaheadKey("ArrowDown", none)).toBe(false);
    expect(isTypeaheadKey(" ", none)).toBe(false);
    expect(isTypeaheadKey("t", { ...none, ctrl: true })).toBe(false);
    expect(isTypeaheadKey("t", { ...none, meta: true })).toBe(false);
  });
});

describe("moveIndex", () => {
  it("clamps at both ends and enters from the matching end", () => {
    expect(moveIndex(-1, 1, 5)).toBe(0);
    expect(moveIndex(-1, -1, 5)).toBe(4);
    expect(moveIndex(0, -1, 5)).toBe(0);
    expect(moveIndex(4, 1, 5)).toBe(4);
    expect(moveIndex(2, 1, 5)).toBe(3);
    expect(moveIndex(2, -10, 5)).toBe(0);
    expect(moveIndex(2, 10, 5)).toBe(4);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});

describe("filterOptionIndexes", () => {
  const opts = [
    { label: "A", description: "IPv4 address" },
    { label: "AAAA", description: "IPv6 address" },
    { label: "CAA", description: "Certification Authority Authorization" },
    { label: "TXT", description: "Text" },
  ];

  it("returns everything in order for an empty query", () => {
    expect(filterOptionIndexes(opts, "")).toEqual([0, 1, 2, 3]);
    expect(filterOptionIndexes(opts, "   ")).toEqual([0, 1, 2, 3]);
  });

  it("ranks label prefix, then label substring, then description", () => {
    expect(filterOptionIndexes(opts, "a")).toEqual([0, 1, 2]);
    expect(filterOptionIndexes(opts, "ipv4")).toEqual([0]);
    expect(filterOptionIndexes(opts, "TEXT")).toEqual([3]);
    expect(filterOptionIndexes(opts, "zzz")).toEqual([]);
  });
});
