import { describe, expect, it } from "vitest";
import { parseZonefile } from "./zonefile-parser";

describe("parseZonefile", () => {
  it("preserves parentheses inside quoted LUA record content", () => {
    const parsed = parseZonefile(`
$ORIGIN example.com.
app 60 IN LUA A "dblookup('traefik.example.net', pdns.A)[1]"
`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.zones[0]?.rrsets[0]?.records[0]?.content).toBe(
      `A "dblookup('traefik.example.net', pdns.A)[1]"`,
    );
  });

  it("preserves parentheses inside quoted TXT record content", () => {
    const parsed = parseZonefile(`
$ORIGIN example.com.
message 300 IN TXT "keep (these) parentheses"
`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.zones[0]?.rrsets[0]?.records[0]?.content).toBe('"keep (these) parentheses"');
  });

  it("removes unquoted continuation parentheses from a multiline SOA record", () => {
    const parsed = parseZonefile(`
$ORIGIN example.com.
@ 3600 IN SOA ns1.example.com. hostmaster.example.com. (
  2026081101 ; serial
  10800      ; refresh
  3600       ; retry
  604800     ; expire
  3600       ; minimum
)
`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.zones[0]?.rrsets[0]?.records[0]?.content).toBe(
      "ns1.example.com. hostmaster.example.com. 2026081101 10800 3600 604800 3600",
    );
  });
});
