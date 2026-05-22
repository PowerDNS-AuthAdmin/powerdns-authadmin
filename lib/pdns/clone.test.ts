import { describe, expect, it } from "vitest";
import { rewriteName, rewriteRRsetsForClone, type CloneRRset } from "./clone";

describe("rewriteName", () => {
  it("rewrites the apex", () => {
    expect(rewriteName("example.com.", "example.com.", "new.example.")).toBe("new.example.");
  });

  it("rewrites a subdomain by substituting the suffix", () => {
    expect(rewriteName("www.example.com.", "example.com.", "new.example.")).toBe(
      "www.new.example.",
    );
  });

  it("preserves deeper subdomains correctly", () => {
    expect(rewriteName("a.b.c.example.com.", "example.com.", "new.example.")).toBe(
      "a.b.c.new.example.",
    );
  });

  it("does NOT rewrite a sibling zone with a shared suffix", () => {
    // `evil-example.com.` should never be mistaken for `example.com.`
    // since the suffix match anchors on the leading dot.
    expect(rewriteName("evil-example.com.", "example.com.", "new.example.")).toBe(
      "evil-example.com.",
    );
  });

  it("leaves unrelated names alone", () => {
    expect(rewriteName("other.org.", "example.com.", "new.example.")).toBe("other.org.");
  });
});

describe("rewriteRRsetsForClone", () => {
  const sample: CloneRRset[] = [
    {
      name: "example.com.",
      type: "SOA",
      ttl: 3600,
      records: [{ content: "ns1.example.com. hostmaster.example.com. 1 …" }],
    },
    {
      name: "example.com.",
      type: "NS",
      ttl: 3600,
      records: [{ content: "ns1.example.com." }, { content: "ns2.example.com." }],
    },
    {
      name: "www.example.com.",
      type: "A",
      ttl: 300,
      records: [{ content: "192.0.2.10" }],
    },
    {
      name: "evil-example.com.",
      type: "A",
      ttl: 300,
      records: [{ content: "203.0.113.5" }],
    },
  ];

  it("drops the SOA rrset (PDNS regenerates one on create)", () => {
    const out = rewriteRRsetsForClone(sample, "example.com.", "new.example.");
    expect(out.find((r) => r.type === "SOA")).toBeUndefined();
  });

  it("rewrites apex and subdomain names but leaves cross-zone names alone", () => {
    const out = rewriteRRsetsForClone(sample, "example.com.", "new.example.");
    expect(out.map((r) => `${r.type}:${r.name}`)).toEqual([
      "NS:new.example.",
      "A:www.new.example.",
      "A:evil-example.com.",
    ]);
  });

  it("preserves ttl, type, and record content verbatim", () => {
    const out = rewriteRRsetsForClone(sample, "example.com.", "new.example.");
    const www = out.find((r) => r.type === "A" && r.name.startsWith("www."));
    expect(www?.ttl).toBe(300);
    expect(www?.records).toEqual([{ content: "192.0.2.10" }]);
  });

  it("returns a deep copy — does not share record objects with the input", () => {
    const out = rewriteRRsetsForClone(sample, "example.com.", "new.example.");
    const inputWww = sample.find((r) => r.name === "www.example.com.")!;
    const outputWww = out.find((r) => r.type === "A" && r.records[0]?.content === "192.0.2.10")!;
    expect(outputWww.records[0]).not.toBe(inputWww.records[0]);
  });

  it("throws when either zone name lacks the trailing dot", () => {
    expect(() => rewriteRRsetsForClone(sample, "example.com", "new.example.")).toThrow();
    expect(() => rewriteRRsetsForClone(sample, "example.com.", "new.example")).toThrow();
  });

  it("accepts an empty rrset list", () => {
    expect(rewriteRRsetsForClone([], "example.com.", "new.example.")).toEqual([]);
  });
});
