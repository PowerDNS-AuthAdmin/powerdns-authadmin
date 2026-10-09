import { describe, expect, it } from "vitest";
import { canonicalName, canonicalZone, filterRows, flattenRrsets } from "./_records";

describe("mcp record helpers", () => {
  it("canonicalises zone and owner names like the web editor", () => {
    expect(canonicalZone("Example.COM")).toBe("example.com.");
    expect(canonicalZone("example.com.")).toBe("example.com.");
    const zone = "example.com.";
    expect(canonicalName("@", zone)).toBe(zone);
    expect(canonicalName("", zone)).toBe(zone);
    expect(canonicalName("www", zone)).toBe("www.example.com.");
    expect(canonicalName("WWW.example.com.", zone)).toBe("www.example.com.");
    expect(canonicalName("example.com", zone)).toBe(zone);
  });

  it("flattens RRsets to one row per value, sorted", () => {
    const rows = flattenRrsets([
      {
        name: "www.example.com.",
        type: "A",
        ttl: 300,
        records: [{ content: "192.0.2.2" }, { content: "192.0.2.1", disabled: true }],
      },
      {
        name: "example.com.",
        type: "MX",
        ttl: 3600,
        records: [{ content: "10 mail.example.com." }],
      },
    ]);
    expect(
      rows.map((r) => `${r.name} ${r.type} ${r.content}${r.disabled ? " (disabled)" : ""}`),
    ).toEqual([
      "example.com. MX 10 mail.example.com.",
      "www.example.com. A 192.0.2.1 (disabled)",
      "www.example.com. A 192.0.2.2",
    ]);
  });

  it("filters by relative name and case-insensitive type", () => {
    const rows = flattenRrsets([
      { name: "www.example.com.", type: "A", ttl: 300, records: [{ content: "192.0.2.2" }] },
      { name: "www.example.com.", type: "AAAA", ttl: 300, records: [{ content: "2001:db8::1" }] },
      { name: "example.com.", type: "TXT", ttl: 300, records: [{ content: '"v=spf1 -all"' }] },
    ]);
    expect(filterRows(rows, { zone: "example.com.", name: "www" }).map((r) => r.type)).toEqual([
      "A",
      "AAAA",
    ]);
    expect(filterRows(rows, { zone: "example.com.", type: "txt" }).map((r) => r.name)).toEqual([
      "example.com.",
    ]);
    expect(filterRows(rows, { zone: "example.com.", name: "@", type: "A" })).toEqual([]);
  });
});
