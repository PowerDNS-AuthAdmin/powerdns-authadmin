/**
 * lib/dns/zonefile-parser.fuzz.test.ts
 *
 * Property-based tests for the BIND zonefile parser - operator-uploaded,
 * untrusted input (CONTRIBUTING § Testing requires fuzzing for such parsers).
 *
 * Invariants:
 *   - the parser never throws, whatever the bytes;
 *   - every emitted rrset is well-formed: a fully-qualified lowercase owner
 *     under the active origin (or absolute), a type that looks like an RR
 *     type, a non-negative integer TTL, non-empty content;
 *   - a zone rendered by `formatZonefile` parses back to the same records,
 *     and parsing the re-rendered parse is a fixed point;
 *   - a blank-owner continuation never invents an owner: the record lands on
 *     the previous line's owner.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseZonefile } from "./zonefile-parser";
import { formatZonefile } from "./zonefile-formatter";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

const RUNS = { numRuns: 500 };

const TYPE_SHAPE = /^(?:[A-Z][A-Z0-9-]*|TYPE\d+)$/;

const label = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/)
  .filter((s) => !s.startsWith("-") && !s.endsWith("-"));
const origin = fc.array(label, { minLength: 1, maxLength: 3 }).map((ls) => `${ls.join(".")}.`);

/** Record types with simple, whitespace-free presentation content. */
const simpleType = fc.constantFrom("A", "AAAA", "NS", "CNAME", "PTR", "TXT", "MX");
const content = (type: string): fc.Arbitrary<string> => {
  switch (type) {
    case "A":
      return fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join("."));
    case "AAAA":
      return fc
        .array(fc.nat(0xffff), { minLength: 8, maxLength: 8 })
        .map((h) => h.map((n) => n.toString(16)).join(":"));
    case "MX":
      return fc.tuple(fc.nat(65535), label).map(([p, l]) => `${p} ${l}.example.`);
    case "TXT":
      return fc
        .string({ maxLength: 40 })
        .map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    default:
      return label.map((l) => `${l}.example.`);
  }
};

const rrset = (zoneName: string) =>
  simpleType.chain((type) =>
    fc
      .record({
        owner: fc.oneof(
          fc.constant(zoneName),
          label.map((l) => `${l}.${zoneName}`),
        ),
        ttl: fc.integer({ min: 1, max: 604_800 }),
        records: fc.uniqueArray(content(type), { minLength: 1, maxLength: 3 }),
      })
      .map((r) => ({
        name: r.owner,
        type,
        ttl: r.ttl,
        records: r.records.map((c) => ({ content: c })),
      })),
  );

/** A zone whose (name, type) pairs are unique, as PDNS would hand it back. */
const zone: fc.Arbitrary<PdnsZoneDetail> = origin.chain((name) =>
  fc
    .uniqueArray(rrset(name), {
      minLength: 0,
      maxLength: 12,
      selector: (r) => `${r.name}|${r.type}`,
    })
    .map((rrsets) => ({ id: name, name, kind: "Native", rrsets })),
);

const flatten = (z: { rrsets?: PdnsZoneDetail["rrsets"] }): string[] =>
  (z.rrsets ?? [])
    .flatMap((rr) => rr.records.map((r) => `${rr.name} ${rr.ttl} ${rr.type} ${r.content}`))
    .sort();

describe("zonefile parser - fuzz", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (input) => {
        const out = parseZonefile(input);
        expect(Array.isArray(out.zones)).toBe(true);
        expect(Array.isArray(out.diagnostics)).toBe(true);
      }),
      RUNS,
    );
  });

  it("never throws on arbitrary lines under a valid $ORIGIN", () => {
    fc.assert(
      fc.property(
        origin,
        fc.array(fc.string({ unit: "grapheme-ascii", maxLength: 60 }), { maxLength: 8 }),
        (o, lines) => {
          const out = parseZonefile([`$ORIGIN ${o}`, ...lines].join("\n"));
          expect(out.zones[0]?.name).toBe(o);
        },
      ),
      RUNS,
    );
  });

  it("every emitted rrset is well-formed and owned under the origin or absolute", () => {
    fc.assert(
      fc.property(
        origin,
        fc.array(fc.string({ unit: "grapheme-ascii", maxLength: 60 }), { maxLength: 8 }),
        (o, lines) => {
          const out = parseZonefile([`$ORIGIN ${o}`, ...lines].join("\n"));
          for (const z of out.zones) {
            for (const rr of z.rrsets) {
              expect(rr.name.endsWith(".")).toBe(true);
              expect(rr.name).toBe(rr.name.toLowerCase());
              expect(TYPE_SHAPE.test(rr.type)).toBe(true);
              expect(Number.isInteger(rr.ttl) && rr.ttl >= 0).toBe(true);
              expect(rr.records.length).toBeGreaterThan(0);
              for (const r of rr.records) expect(r.content.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it("format → parse round-trips every record and is a fixed point", () => {
    fc.assert(
      fc.property(zone, (z) => {
        const once = parseZonefile(formatZonefile(z));
        expect(once.diagnostics).toEqual([]);
        expect(once.zones).toHaveLength(1);
        expect(flatten(once.zones[0]!)).toEqual(flatten(z));

        const again = parseZonefile(formatZonefile({ ...z, rrsets: once.zones[0]!.rrsets }));
        expect(flatten(again.zones[0]!)).toEqual(flatten(once.zones[0]!));
      }),
      RUNS,
    );
  });

  it("a blank-owner continuation always lands on the previous owner", () => {
    fc.assert(
      fc.property(
        origin,
        label,
        fc.integer({ min: 1, max: 86_400 }),
        fc.constantFrom("    ", "\t", " \t "),
        fc.constantFrom("ttl", "class", "type"),
        (o, l, ttl, indent, lead) => {
          const first = `${l} 300 IN A 192.0.2.1`;
          const continuation =
            lead === "ttl"
              ? `${indent}${ttl} IN A 192.0.2.2`
              : lead === "class"
                ? `${indent}IN A 192.0.2.2`
                : `${indent}A 192.0.2.2`;
          const out = parseZonefile(`$ORIGIN ${o}\n${first}\n${continuation}\n`);
          expect(out.diagnostics).toEqual([]);
          const names = new Set(out.zones[0]!.rrsets.map((rr) => rr.name));
          expect([...names]).toEqual([`${l}.${o}`]);
          expect(out.zones[0]!.rrsets[0]!.records.map((r) => r.content)).toEqual([
            "192.0.2.1",
            "192.0.2.2",
          ]);
        },
      ),
      RUNS,
    );
  });
});
