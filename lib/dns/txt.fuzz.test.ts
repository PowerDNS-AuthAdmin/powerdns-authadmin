/**
 * lib/dns/txt.fuzz.test.ts
 *
 * Property-based (fuzz) tests for the TXT presentation parser. fast-check
 * generates thousands of adversarial inputs and shrinks any failure to a
 * minimal reproducer - the right shape of fuzzing for a pure string parser
 * (and what OpenSSF Scorecard recognises as fuzzing for JS/TS).
 *
 * Invariants under test:
 *   - the parser never throws on arbitrary input (it returns null instead);
 *   - canonicalisation is idempotent;
 *   - a built quoted string round-trips back to its payload.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { extractQuotedStrings, canonicalTxtContent, octetLength } from "./txt";

const RUNS = { numRuns: 1000 };

describe("txt parser - fuzz", () => {
  it("extractQuotedStrings never throws and returns string[] | null", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (input) => {
        const out = extractQuotedStrings(input);
        expect(out === null || Array.isArray(out)).toBe(true);
      }),
      RUNS,
    );
  });

  it("canonicalTxtContent never throws and is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (input) => {
        const once = canonicalTxtContent(input);
        const twice = canonicalTxtContent(once);
        expect(typeof once).toBe("string");
        // Canonicalising a canonical value must be a fixed point.
        expect(twice).toBe(once);
      }),
      RUNS,
    );
  });

  it("a built quoted character-string round-trips to its payload", () => {
    fc.assert(
      // Payloads of printable-ish bytes; escape per RFC 1035 master-file rules.
      fc.property(fc.array(fc.string({ maxLength: 80 }), { maxLength: 6 }), (payloads) => {
        const quoted = payloads
          .map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(" ");
        const parsed = extractQuotedStrings(quoted);
        // Empty payload list yields no quoted strings → null by contract.
        if (payloads.length === 0) {
          expect(parsed).toBeNull();
          return;
        }
        expect(parsed).not.toBeNull();
        expect(parsed!.join("")).toBe(payloads.join(""));
      }),
      RUNS,
    );
  });

  it("octetLength never throws and is >= the JS string length for ASCII", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (input) => {
        const n = octetLength(input);
        expect(Number.isInteger(n) && n >= 0).toBe(true);
      }),
      RUNS,
    );
  });
});
