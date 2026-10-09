import { describe, expect, it } from "vitest";
import { parseTtl, parseZonefile } from "./zonefile-parser";
import { formatZonefile } from "./zonefile-formatter";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

/** First record content of the first rrset - the shape most tests assert on. */
function firstContent(zonefile: string): string | undefined {
  return parseZonefile(zonefile).zones[0]?.rrsets[0]?.records[0]?.content;
}

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

  it("keeps a multiline LUA record intact when the Lua itself calls functions", () => {
    const parsed = parseZonefile(`
$ORIGIN example.com.
www 60 IN LUA A ( "ifportup(443, {'192.0.2.1', '192.0.2.2'})" )
`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.zones[0]?.rrsets[0]?.records[0]?.content).toBe(
      `A "ifportup(443, {'192.0.2.1', '192.0.2.2'})"`,
    );
  });

  it("treats a semicolon inside quoted content as data, not a comment", () => {
    expect(
      firstContent(`$ORIGIN example.com.\nwww 60 IN LUA A "local x = 1; return '192.0.2.1'"\n`),
    ).toBe(`A "local x = 1; return '192.0.2.1'"`);
  });

  it("strips a trailing comment that follows quoted content", () => {
    expect(firstContent(`$ORIGIN example.com.\nt 300 IN TXT "a (b)" ; why not\n`)).toBe('"a (b)"');
  });

  it("keeps each chunk of a multi-string TXT record", () => {
    expect(firstContent(`$ORIGIN example.com.\nt 300 IN TXT "chunk one" "chunk two"\n`)).toBe(
      '"chunk one" "chunk two"',
    );
  });

  it("preserves whitespace inside a quoted string", () => {
    // Separators between fields normalize, but bytes inside the quotes are
    // rdata and must survive verbatim.
    expect(firstContent(`$ORIGIN example.com.\nt 300 IN TXT "two  spaces"   "and  more"\n`)).toBe(
      '"two  spaces" "and  more"',
    );
  });

  it("preserves an escaped quote adjacent to parentheses", () => {
    expect(firstContent(`$ORIGIN example.com.\nt 300 IN TXT "say \\"hi (there)\\" now"\n`)).toBe(
      '"say \\"hi (there)\\" now"',
    );
  });

  it("preserves an escaped parenthesis in unquoted rdata", () => {
    expect(firstContent(`$ORIGIN example.com.\nt 300 IN TXT abc\\(def\n`)).toBe("abc\\(def");
  });

  it("splits fields on a parenthesis flush against a value", () => {
    expect(
      firstContent(
        `$ORIGIN example.com.\n@ 3600 IN SOA ns1.example.com. host.example.com. (2026081101 10800 3600 604800 3600)\n`,
      ),
    ).toBe("ns1.example.com. host.example.com. 2026081101 10800 3600 604800 3600");
  });

  it("reports an unterminated quoted string without consuming the rest of the file", () => {
    // A character-string cannot span lines, so the open quote must not leave
    // the scanner in a quoted state that swallows every following record.
    const parsed = parseZonefile(`
$ORIGIN example.com.
t 300 IN TXT "oops (
n 300 IN A 192.0.2.1
`);

    expect(parsed.diagnostics).toEqual([
      {
        line: 3,
        level: "error",
        message: "Unterminated quoted string (a character-string cannot span lines).",
      },
    ]);
    const a = parsed.zones[0]?.rrsets.find((rr) => rr.type === "A");
    expect(a?.records[0]?.content).toBe("192.0.2.1");
  });

  it("still reports an unterminated parenthesised record", () => {
    const parsed = parseZonefile(`
$ORIGIN example.com.
@ 3600 IN SOA ns1.example.com. host.example.com. (
  2026081101 10800 3600 604800 3600
`);

    expect(parsed.diagnostics).toEqual([
      {
        line: 3,
        level: "error",
        message: "Unterminated parenthesised record (no closing ')').",
      },
    ]);
  });

  it("reports a directive with no argument as malformed", () => {
    const parsed = parseZonefile(`$ORIGIN example.com.\n$TTL\nt 300 IN A 192.0.2.1\n`);

    expect(parsed.diagnostics).toEqual([
      { line: 2, level: "error", message: "Malformed directive: $TTL" },
    ]);
    expect(parsed.zones[0]?.rrsets[0]?.records[0]?.content).toBe("192.0.2.1");
  });

  it("accepts tabs as field separators", () => {
    expect(firstContent(`$ORIGIN example.com.\nt\t300\tIN\tTXT\t"x y"\n`)).toBe('"x y"');
  });
});

describe("parseZonefile - blank owners, unit TTLs and type validation", () => {
  const records = (zonefile: string) =>
    parseZonefile(zonefile).zones[0]?.rrsets.flatMap((rr) =>
      rr.records.map((r) => `${rr.name} ${rr.ttl} ${rr.type} ${r.content}`),
    ) ?? [];

  it("a blank-owner line starting with a TTL reuses the previous owner", () => {
    // Used to import as `300.example.com. A` with no diagnostic.
    const parsed = parseZonefile(
      `$ORIGIN example.com.\nwww 300 IN A 192.0.2.4\n    300 IN A 192.0.2.5\n`,
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(
      records(`$ORIGIN example.com.\nwww 300 IN A 192.0.2.4\n    300 IN A 192.0.2.5\n`),
    ).toEqual(["www.example.com. 300 A 192.0.2.4", "www.example.com. 300 A 192.0.2.5"]);
  });

  it("a tab-indented line starting with the class reuses the previous owner", () => {
    // Used to import as `in.example.com. A`.
    expect(records(`$ORIGIN example.com.\nwww 300 IN A 192.0.2.4\n\t\tIN A 192.0.2.6\n`)).toEqual([
      "www.example.com. 300 A 192.0.2.4",
      "www.example.com. 300 A 192.0.2.6",
    ]);
  });

  it("a blank-owner line starting with the type reuses the previous owner and $TTL", () => {
    expect(
      records(
        `$TTL 600\n$ORIGIN example.com.\nmail IN MX 10 mx1.example.com.\n  MX 20 mx2.example.com.\n`,
      ),
    ).toEqual([
      "mail.example.com. 600 MX 10 mx1.example.com.",
      "mail.example.com. 600 MX 20 mx2.example.com.",
    ]);
  });

  it("blank owner carries across a multi-line parenthesised record", () => {
    const out = records(
      `$ORIGIN example.com.\n@ 3600 IN NS ns1.example.com.\n  3600 IN SOA ns1.example.com. host.example.com. (\n    1 2 3 4 5 )\n`,
    );
    expect(out).toContain("example.com. 3600 SOA ns1.example.com. host.example.com. 1 2 3 4 5");
  });

  it("a blank owner with no previous record is an error, not a record", () => {
    const parsed = parseZonefile(`$ORIGIN example.com.\n    300 IN A 192.0.2.5\n`);
    expect(parsed.zones[0]?.rrsets).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({ line: 2, level: "error" });
    expect(parsed.diagnostics[0]?.message).toMatch(/blank owner/);
  });

  it("a new $ORIGIN forgets the previous owner", () => {
    const parsed = parseZonefile(
      `$ORIGIN a.example.\nwww 300 IN A 192.0.2.1\n$ORIGIN b.example.\n    300 IN A 192.0.2.2\n`,
    );
    expect(parsed.zones[1]?.rrsets).toEqual([]);
    expect(parsed.diagnostics.some((d) => d.message.includes("blank owner"))).toBe(true);
  });

  it("an indented line whose first field is an owner label is still an explicit owner", () => {
    expect(records(`$ORIGIN example.com.\n  www IN A 192.0.2.4\n`)).toEqual([
      "www.example.com. 3600 A 192.0.2.4",
    ]);
  });

  it("parses unit TTLs on records", () => {
    // Used to produce type `1H` with rdata `IN A 192.0.2.7`.
    expect(records(`$ORIGIN example.com.\n@ 1h IN A 192.0.2.7\n`)).toEqual([
      "example.com. 3600 A 192.0.2.7",
    ]);
    expect(records(`$ORIGIN example.com.\n@ IN 1d A 192.0.2.7\n`)).toEqual([
      "example.com. 86400 A 192.0.2.7",
    ]);
    expect(records(`$ORIGIN example.com.\n@ 1h30m IN A 192.0.2.7\n`)).toEqual([
      "example.com. 5400 A 192.0.2.7",
    ]);
  });

  it("parses a unit $TTL", () => {
    expect(records(`$TTL 1h\n$ORIGIN example.com.\n@ IN A 192.0.2.7\n`)).toEqual([
      "example.com. 3600 A 192.0.2.7",
    ]);
    const bad = parseZonefile(`$TTL 1x\n$ORIGIN example.com.\n@ IN A 192.0.2.7\n`);
    expect(bad.diagnostics).toEqual([
      { line: 1, level: "error", message: "Invalid $TTL value: 1x" },
    ]);
  });

  it("accepts a lowercase class and type", () => {
    expect(records(`$ORIGIN example.com.\nwww 300 in a 192.0.2.4\n`)).toEqual([
      "www.example.com. 300 A 192.0.2.4",
    ]);
  });

  it("rejects a non-IN class with a diagnostic", () => {
    const parsed = parseZonefile(`$ORIGIN example.com.\nwww 300 CH A 192.0.2.4\n`);
    expect(parsed.zones[0]?.rrsets).toEqual([]);
    expect(parsed.diagnostics[0]?.message).toMatch(/Unsupported class CH/);
  });

  it("a token that cannot be a record type is a diagnostic, never a record", () => {
    const parsed = parseZonefile(`$ORIGIN example.com.\nwww 300 IN 1.2.3.4 A\n`);
    expect(parsed.zones[0]?.rrsets).toEqual([]);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({ line: 2, level: "error" });
    expect(parsed.diagnostics[0]?.message).toMatch(/Expected a record type/);
  });

  it("accepts RFC 3597 TYPE<n> and hyphenated mnemonics", () => {
    expect(
      records(
        `$ORIGIN example.com.\nx 300 IN TYPE65534 \\# 1 00\nx 300 IN EUI-48 00-00-5e-00-53-2a\n`,
      ),
    ).toEqual([
      "x.example.com. 300 TYPE65534 \\# 1 00",
      "x.example.com. 300 EUI-48 00-00-5e-00-53-2a",
    ]);
  });
});

describe("parseTtl", () => {
  it("accepts seconds and BIND units, case-insensitively", () => {
    expect(parseTtl("300")).toBe(300);
    expect(parseTtl("1h")).toBe(3600);
    expect(parseTtl("2D")).toBe(172_800);
    expect(parseTtl("1w")).toBe(604_800);
    expect(parseTtl("1h30m")).toBe(5400);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "h", "-1", "1.5", "1x", "1h 30m", "abc"]) {
      expect(parseTtl(bad)).toBeNull();
    }
  });
});

describe("formatZonefile → parseZonefile round-trip", () => {
  // The formatter documents that its output must survive the parser. Export →
  // import is the path an operator actually takes between two backends, and
  // it is where quoted parentheses used to be silently rewritten.
  const zone: PdnsZoneDetail = {
    id: "example.com.",
    name: "example.com.",
    kind: "Master",
    rrsets: [
      {
        name: "example.com.",
        type: "SOA",
        ttl: 3600,
        records: [
          { content: "ns1.example.com. hostmaster.example.com. 2026081101 10800 3600 604800 3600" },
        ],
      },
      {
        name: "www.example.com.",
        type: "LUA",
        ttl: 60,
        records: [{ content: `A "ifportup(443, {'192.0.2.1', '192.0.2.2'})"` }],
      },
      {
        name: "t.example.com.",
        type: "TXT",
        ttl: 300,
        records: [{ content: '"keep (these) parens"' }, { content: '"and  the  spacing"' }],
      },
      {
        name: "example.com.",
        type: "NS",
        ttl: 3600,
        records: [{ content: "ns1.example.com." }],
      },
    ],
  };

  it("round-trips every record content unchanged", () => {
    const parsed = parseZonefile(formatZonefile(zone));

    expect(parsed.diagnostics).toEqual([]);
    const seen = parsed.zones[0]?.rrsets.flatMap((rr) =>
      rr.records.map((r) => `${rr.name} ${rr.ttl} ${rr.type} ${r.content}`),
    );
    expect(seen?.sort()).toEqual(
      (zone.rrsets ?? [])
        .flatMap((rr) => rr.records.map((r) => `${rr.name} ${rr.ttl} ${rr.type} ${r.content}`))
        .sort(),
    );
  });
});
