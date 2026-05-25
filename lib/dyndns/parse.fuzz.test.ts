/**
 * lib/dyndns/parse.fuzz.test.ts
 *
 * Property-based (fuzz) tests for the DynDNS request parsers — the code path
 * that turns an untrusted HTTP request (query string + Basic-auth header)
 * into a structured update. Adversarial input here comes straight off the
 * wire, so "never throw, always return a well-formed result" matters.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseDynDnsRequest, parseBasicAuth, findLongestZoneMatch } from "./parse";

const RUNS = { numRuns: 1000 };

describe("dyndns parsers — fuzz", () => {
  it("parseBasicAuth never throws; returns null or {user, pass}", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ unit: "binary" }), { nil: null }), (header) => {
        const out = parseBasicAuth(header);
        if (out !== null) {
          expect(typeof out.user).toBe("string");
          expect(typeof out.pass).toBe("string");
          expect(out.user.length).toBeGreaterThan(0);
          expect(out.pass.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it("parseBasicAuth round-trips a well-formed credential", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((u) => !u.includes(":")),
        fc.string({ minLength: 1 }),
        (user, pass) => {
          const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
          const out = parseBasicAuth(`Basic ${token}`);
          expect(out).toEqual({ user, pass });
        },
      ),
      RUNS,
    );
  });

  it("parseDynDnsRequest never throws on arbitrary query strings", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string(), fc.string()), { maxLength: 8 }), (params) => {
        const url = new URL("https://dns.example.com/nic/update");
        for (const [k, v] of params) {
          // URLSearchParams rejects nothing; keys can be arbitrary.
          url.searchParams.append(k, v);
        }
        const out = parseDynDnsRequest(url);
        expect(out).toBeTypeOf("object");
      }),
      RUNS,
    );
  });

  it("findLongestZoneMatch never throws; result is null or a suffix-matching candidate", () => {
    fc.assert(
      fc.property(fc.domain(), fc.array(fc.domain(), { maxLength: 10 }), (hostname, zones) => {
        const out = findLongestZoneMatch(
          hostname.toLowerCase(),
          zones.map((z) => z.toLowerCase()),
        );
        if (out !== null) {
          expect(zones.map((z) => z.toLowerCase())).toContain(out);
          const h = hostname.toLowerCase();
          expect(h === out || h.endsWith(`.${out}`)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
