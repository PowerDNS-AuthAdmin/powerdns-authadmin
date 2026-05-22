/**
 * lib/pdns/rrset-hash.test.ts
 *
 * Tests for the structural-hash helper used by ADR 0010's per-RRset
 * optimistic concurrency check. The hash is the comparison key for
 * the editor's 409-on-conflict path; the canonicalization rules
 * here determine which edits collide and which don't, so every rule
 * gets a dedicated test that pins the behavior.
 */

import { describe, expect, it } from "vitest";
import {
  detectRRsetConflicts,
  rrsetHash,
  type ConflictCandidate,
  type HashableRRset,
} from "./rrset-hash";

function rrset(overrides: Partial<HashableRRset> = {}): HashableRRset {
  return {
    name: "www.example.com.",
    type: "A",
    ttl: 300,
    records: [{ content: "192.0.2.1" }],
    ...overrides,
  };
}

describe("rrsetHash", () => {
  describe("output shape", () => {
    it("returns exactly 16 hex characters", () => {
      const h = rrsetHash(rrset());
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it("is deterministic for the same input", () => {
      const a = rrsetHash(rrset());
      const b = rrsetHash(rrset());
      expect(a).toBe(b);
    });
  });

  describe("name canonicalization", () => {
    it("hash is the same for uppercase vs lowercase name", () => {
      const lower = rrsetHash(rrset({ name: "www.example.com." }));
      const upper = rrsetHash(rrset({ name: "WWW.EXAMPLE.COM." }));
      const mixed = rrsetHash(rrset({ name: "WwW.ExAmPle.com." }));
      expect(upper).toBe(lower);
      expect(mixed).toBe(lower);
    });

    it("differs when the name differs in label content", () => {
      expect(rrsetHash(rrset({ name: "www.example.com." }))).not.toBe(
        rrsetHash(rrset({ name: "mail.example.com." })),
      );
    });
  });

  describe("type canonicalization", () => {
    it("hash is the same for uppercase vs lowercase type", () => {
      const upper = rrsetHash(rrset({ type: "A" }));
      const lower = rrsetHash(rrset({ type: "a" }));
      expect(lower).toBe(upper);
    });

    it("differs for distinct types", () => {
      expect(rrsetHash(rrset({ type: "A" }))).not.toBe(rrsetHash(rrset({ type: "AAAA" })));
    });
  });

  describe("TTL", () => {
    it("differs when TTL differs", () => {
      expect(rrsetHash(rrset({ ttl: 300 }))).not.toBe(rrsetHash(rrset({ ttl: 3600 })));
    });
  });

  describe("records", () => {
    it("is order-independent for records", () => {
      const a = rrsetHash(
        rrset({
          records: [{ content: "192.0.2.1" }, { content: "192.0.2.2" }, { content: "192.0.2.3" }],
        }),
      );
      const b = rrsetHash(
        rrset({
          records: [{ content: "192.0.2.3" }, { content: "192.0.2.1" }, { content: "192.0.2.2" }],
        }),
      );
      expect(b).toBe(a);
    });

    it("differs when a record is added", () => {
      const one = rrsetHash(rrset({ records: [{ content: "192.0.2.1" }] }));
      const two = rrsetHash(
        rrset({ records: [{ content: "192.0.2.1" }, { content: "192.0.2.2" }] }),
      );
      expect(two).not.toBe(one);
    });

    it("differs when a record's content changes", () => {
      const a = rrsetHash(rrset({ records: [{ content: "192.0.2.1" }] }));
      const b = rrsetHash(rrset({ records: [{ content: "192.0.2.2" }] }));
      expect(b).not.toBe(a);
    });
  });

  describe("disabled flag normalization", () => {
    it("absent disabled is treated as false (so {content} === {content, disabled: false})", () => {
      const absent = rrsetHash(rrset({ records: [{ content: "192.0.2.1" }] }));
      const explicit = rrsetHash(rrset({ records: [{ content: "192.0.2.1", disabled: false }] }));
      expect(explicit).toBe(absent);
    });

    it("disabled: true differs from disabled: false / absent", () => {
      const enabled = rrsetHash(rrset({ records: [{ content: "192.0.2.1" }] }));
      const disabled = rrsetHash(rrset({ records: [{ content: "192.0.2.1", disabled: true }] }));
      expect(disabled).not.toBe(enabled);
    });

    it("disambiguates identical content with different disabled flags via secondary sort", () => {
      // Edge case: two records with the same content but different
      // disabled state. The primary sort (content) ties; the
      // secondary sort (disabled) breaks the tie deterministically.
      const a = rrsetHash(
        rrset({
          records: [
            { content: "192.0.2.1", disabled: true },
            { content: "192.0.2.1", disabled: false },
          ],
        }),
      );
      const b = rrsetHash(
        rrset({
          records: [
            { content: "192.0.2.1", disabled: false },
            { content: "192.0.2.1", disabled: true },
          ],
        }),
      );
      // Order-independent — same hash.
      expect(b).toBe(a);
      // And distinct from a single-record variant.
      const single = rrsetHash(rrset({ records: [{ content: "192.0.2.1" }] }));
      expect(a).not.toBe(single);
    });
  });

  describe("edge cases", () => {
    it("handles an empty records array", () => {
      const h = rrsetHash(rrset({ records: [] }));
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it("handles non-ASCII content (IDN, TXT free-form)", () => {
      // Punycode-encoded labels and quoted TXT content with
      // non-ASCII bytes go straight through — no Unicode
      // normalization is applied (PDNS round-trips bytes
      // verbatim).
      const a = rrsetHash(rrset({ type: "TXT", records: [{ content: '"héllo"' }] }));
      const b = rrsetHash(rrset({ type: "TXT", records: [{ content: '"hello"' }] }));
      expect(a).not.toBe(b);
    });

    it("treats trailing-dot vs no-trailing-dot names as distinct", () => {
      // Pinning: DNS canonical form has the trailing dot, but the
      // operator UI sometimes loads names without it. The hash
      // does NOT silently add the dot — we want trailing-dot
      // mismatch to be visible as a conflict so the editor can
      // surface the inconsistency.
      const withDot = rrsetHash(rrset({ name: "www.example.com." }));
      const noDot = rrsetHash(rrset({ name: "www.example.com" }));
      expect(noDot).not.toBe(withDot);
    });
  });
});

describe("detectRRsetConflicts", () => {
  // Helper: stage a live zone snapshot as the route does.
  function liveZone(rrsets: HashableRRset[]): Map<string, HashableRRset> {
    return new Map(rrsets.map((rr) => [`${rr.name}|${rr.type}`, rr]));
  }

  it("returns empty when no changes carry `expected` (legacy clients)", () => {
    const before = liveZone([rrset()]);
    const changes: ConflictCandidate[] = [
      { name: "www.example.com.", type: "A" }, // no expected — skipped
    ];
    expect(detectRRsetConflicts(changes, before)).toEqual([]);
  });

  it("returns no conflict when the live hash matches expected", () => {
    const live = rrset();
    const before = liveZone([live]);
    const changes: ConflictCandidate[] = [
      { name: live.name, type: live.type, expected: { hash: rrsetHash(live) } },
    ];
    expect(detectRRsetConflicts(changes, before)).toEqual([]);
  });

  it("returns a `modified` conflict with currentHash when the live hash differs", () => {
    const live = rrset({ records: [{ content: "192.0.2.99" }] });
    const before = liveZone([live]);
    const staleHash = "deadbeefdeadbeef"; // operator loaded earlier state
    const changes: ConflictCandidate[] = [
      { name: live.name, type: live.type, expected: { hash: staleHash } },
    ];
    const result = detectRRsetConflicts(changes, before);
    expect(result).toEqual([
      {
        rrsetName: live.name,
        rrsetType: live.type,
        reason: "modified",
        currentHash: rrsetHash(live),
      },
    ]);
  });

  it("returns a `deleted` conflict when the live rrset is gone", () => {
    const before = liveZone([]); // empty zone
    const changes: ConflictCandidate[] = [
      { name: "www.example.com.", type: "A", expected: { hash: "abcd1234abcd1234" } },
    ];
    const result = detectRRsetConflicts(changes, before);
    expect(result).toEqual([{ rrsetName: "www.example.com.", rrsetType: "A", reason: "deleted" }]);
    // No currentHash for deleted (nothing to compute).
    expect(result[0]).not.toHaveProperty("currentHash");
  });

  it("aggregates multiple conflicts across the batch", () => {
    const liveA = rrset();
    const liveB = rrset({ name: "mail.example.com.", records: [{ content: "192.0.2.2" }] });
    const before = liveZone([liveA, liveB]);
    const changes: ConflictCandidate[] = [
      // A: hash matches — no conflict.
      { name: liveA.name, type: liveA.type, expected: { hash: rrsetHash(liveA) } },
      // B: hash mismatch — modified.
      { name: liveB.name, type: liveB.type, expected: { hash: "wrongwrongwrong0" } },
      // C: not in zone — deleted.
      { name: "gone.example.com.", type: "A", expected: { hash: "abcd1234abcd1234" } },
      // D: no expected — skipped.
      { name: "other.example.com.", type: "A" },
    ];
    const result = detectRRsetConflicts(changes, before);
    expect(result.length).toBe(2);
    expect(result.map((c) => c.reason)).toEqual(["modified", "deleted"]);
    expect(result.map((c) => c.rrsetName)).toEqual(["mail.example.com.", "gone.example.com."]);
  });

  it("preserves the change-order in the conflict list (for deterministic UI rendering)", () => {
    // Two conflicts in a specific order: result must echo it.
    const liveA = rrset();
    const liveB = rrset({ name: "x.example.com." });
    const before = liveZone([liveA, liveB]);
    const changes: ConflictCandidate[] = [
      { name: liveB.name, type: liveB.type, expected: { hash: "stalebstaleb0000" } },
      { name: liveA.name, type: liveA.type, expected: { hash: "stalealstaleal00" } },
    ];
    const result = detectRRsetConflicts(changes, before);
    expect(result.map((c) => c.rrsetName)).toEqual([liveB.name, liveA.name]);
  });

  it("a change with expected but matching live hash adds nothing", () => {
    // Pinning that the "no conflict" path produces zero entries
    // — not undefined, not a placeholder, just nothing.
    const live = rrset();
    const before = liveZone([live]);
    const result = detectRRsetConflicts(
      [{ name: live.name, type: live.type, expected: { hash: rrsetHash(live) } }],
      before,
    );
    expect(result).toEqual([]);
  });
});
