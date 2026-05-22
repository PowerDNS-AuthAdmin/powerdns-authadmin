/**
 * lib/dns/txt.test.ts
 *
 * Covers TXT character-string parsing and the equality-canonicalization
 * that kills false "out of sync" diffs when two PDNS peers chunk the same
 * long TXT value (DKIM/SPF/DMARC) at different 255-octet boundaries.
 */

import { describe, expect, it } from "vitest";
import { canonicalTxtContent, extractQuotedStrings, octetLength } from "./txt";

describe("extractQuotedStrings", () => {
  it("parses a single quoted string", () => {
    expect(extractQuotedStrings('"v=spf1 -all"')).toEqual(["v=spf1 -all"]);
  });

  it("parses adjacent quoted strings", () => {
    expect(extractQuotedStrings('"part one " "part two"')).toEqual(["part one ", "part two"]);
  });

  it("tolerates arbitrary whitespace between strings", () => {
    expect(extractQuotedStrings('"a"    "b"')).toEqual(["a", "b"]);
  });

  it('unescapes \\" , \\\\ and decimal triples', () => {
    expect(extractQuotedStrings('"a\\"b\\\\c\\065"')).toEqual(['a"b\\cA']);
  });

  it("returns null for bare / unquoted content", () => {
    expect(extractQuotedStrings("v=spf1 -all")).toBeNull();
  });

  it("returns null for an unterminated string", () => {
    expect(extractQuotedStrings('"missing close')).toBeNull();
  });
});

describe("canonicalTxtContent", () => {
  it("collapses split and merged forms to the same key", () => {
    expect(canonicalTxtContent('"ab"')).toBe('"ab"');
    expect(canonicalTxtContent('"a" "b"')).toBe('"ab"');
    expect(canonicalTxtContent('"a" "b"')).toBe(canonicalTxtContent('"ab"'));
  });

  it("is split-boundary independent for a long DKIM key (the reported bug)", () => {
    // The exact value from the bug report: one peer splits the DKIM key
    // into two character-strings, the other serves it merged.
    const split =
      '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApLeZgJDN1uHZZP61sPTb3vatAhl1Whk0OGCJA8Gf1EJ1QVhu5fnbBhx9eReROjNe4YPdHi2MezxrHu4OpiFCmyA3MbnX5rd7+lDtcyeYztkTegyyVtxwwp/Ybf8GNRi90ZAaKstCvovIDgdm7kf9OXUAG10a665XOBXrh3NWqKYuwXTkKSs+otP" "Re+hcIRYSzKld92htya1tYY2LlkRL26G/4AGkSlLimEOyjWWyo6BXlxlwqwGsetfJ8EhL4XTrXA0JSa8R9wbOMAZ8uYQMkNJxvdLTyW02cKrqPlRQLPyvY5EqZ+BO62naOC51yTVLKBznLBf4rZROEjWIMPG8WwIDAQAB"';
    const merged =
      '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApLeZgJDN1uHZZP61sPTb3vatAhl1Whk0OGCJA8Gf1EJ1QVhu5fnbBhx9eReROjNe4YPdHi2MezxrHu4OpiFCmyA3MbnX5rd7+lDtcyeYztkTegyyVtxwwp/Ybf8GNRi90ZAaKstCvovIDgdm7kf9OXUAG10a665XOBXrh3NWqKYuwXTkKSs+otPRe+hcIRYSzKld92htya1tYY2LlkRL26G/4AGkSlLimEOyjWWyo6BXlxlwqwGsetfJ8EhL4XTrXA0JSa8R9wbOMAZ8uYQMkNJxvdLTyW02cKrqPlRQLPyvY5EqZ+BO62naOC51yTVLKBznLBf4rZROEjWIMPG8WwIDAQAB"';
    expect(canonicalTxtContent(split)).toBe(canonicalTxtContent(merged));
  });

  it("keeps genuinely different values distinct", () => {
    expect(canonicalTxtContent('"v=spf1 -all"')).not.toBe(canonicalTxtContent('"v=spf1 ~all"'));
  });

  it("re-escapes quotes and backslashes in the canonical output", () => {
    expect(canonicalTxtContent('"a\\"b" "\\\\c"')).toBe('"a\\"b\\\\c"');
  });

  it("leaves bare/unparseable content untouched (exact comparison)", () => {
    expect(canonicalTxtContent("not quoted")).toBe("not quoted");
    expect(canonicalTxtContent("  spaced  ")).toBe("spaced");
  });

  it("normalizes whitespace differences between chunks", () => {
    expect(canonicalTxtContent('"a"  "b"')).toBe(canonicalTxtContent('"a" "b"'));
  });
});

describe("octetLength", () => {
  it("counts UTF-8 octets, not code units", () => {
    expect(octetLength("abc")).toBe(3);
    expect(octetLength("é")).toBe(2);
    expect(octetLength("😀")).toBe(4);
  });
});
