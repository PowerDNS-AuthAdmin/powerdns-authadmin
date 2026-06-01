/**
 * lib/validators/rr-types/validators.fuzz.test.ts
 *
 * Property-based (fuzz) tests for every per-RR-type content validator. These
 * validators parse free-text record content (operator- or API-supplied), and
 * we've shipped real bugs in them before (SRV port range, AAAA `::`, CAA quote
 * balance). The invariant: validation must never throw and must always return
 * a well-formed result - whatever garbage it's handed.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { getRRTypeValidator, SUPPORTED_TYPES } from "./index";

const RUNS = { numRuns: 600 };

describe("rr-type validators - fuzz", () => {
  for (const type of SUPPORTED_TYPES) {
    it(`${type}.validate never throws and returns a well-formed result`, () => {
      const validator = getRRTypeValidator(type);
      fc.assert(
        fc.property(fc.string({ unit: "binary" }), (content) => {
          const result = validator.validate(content);
          expect(Array.isArray(result.issues)).toBe(true);
          expect(typeof result.normalized).toBe("string");
          for (const issue of result.issues) {
            expect(issue.level === "error" || issue.level === "warning").toBe(true);
            expect(typeof issue.message).toBe("string");
          }
        }),
        RUNS,
      );
    });
  }

  it("an unknown type resolves to a generic validator that also never throws", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ unit: "binary" }), (type, content) => {
        const result = getRRTypeValidator(type).validate(content);
        expect(Array.isArray(result.issues)).toBe(true);
        expect(typeof result.normalized).toBe("string");
      }),
      RUNS,
    );
  });
});
