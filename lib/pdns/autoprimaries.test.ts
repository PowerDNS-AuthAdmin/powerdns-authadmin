import { describe, expect, it } from "vitest";
import { pdnsAutoprimaryListSchema, pdnsAutoprimarySchema } from "./types";

describe("pdnsAutoprimarySchema", () => {
  it("accepts a tuple with all three fields", () => {
    expect(
      pdnsAutoprimarySchema.parse({
        ip: "192.0.2.10",
        nameserver: "ns1.example.",
        account: "customer-x",
      }),
    ).toEqual({
      ip: "192.0.2.10",
      nameserver: "ns1.example.",
      account: "customer-x",
    });
  });

  it("treats `account` as optional", () => {
    expect(
      pdnsAutoprimarySchema.parse({
        ip: "192.0.2.10",
        nameserver: "ns1.example.",
      }),
    ).toEqual({
      ip: "192.0.2.10",
      nameserver: "ns1.example.",
    });
  });

  it("accepts an IPv6 address (no shape constraint at the schema layer)", () => {
    const parsed = pdnsAutoprimarySchema.parse({
      ip: "2001:db8::10",
      nameserver: "ns1.example.",
    });
    expect(parsed.ip).toBe("2001:db8::10");
  });

  it("rejects when required `ip` is missing", () => {
    expect(() => pdnsAutoprimarySchema.parse({ nameserver: "ns1.example." })).toThrow();
  });

  it("rejects when required `nameserver` is missing", () => {
    expect(() => pdnsAutoprimarySchema.parse({ ip: "192.0.2.10" })).toThrow();
  });
});

describe("pdnsAutoprimaryListSchema", () => {
  it("accepts an empty list", () => {
    expect(pdnsAutoprimaryListSchema.parse([])).toEqual([]);
  });

  it("preserves order across mixed accounts", () => {
    const rows = [
      { ip: "192.0.2.10", nameserver: "ns1.a.", account: "a" },
      { ip: "192.0.2.20", nameserver: "ns1.b." },
      { ip: "192.0.2.30", nameserver: "ns1.c.", account: "c" },
    ];
    const parsed = pdnsAutoprimaryListSchema.parse(rows);
    expect(parsed.map((r) => r.ip)).toEqual(["192.0.2.10", "192.0.2.20", "192.0.2.30"]);
  });

  it("rejects when an element is malformed", () => {
    expect(() =>
      pdnsAutoprimaryListSchema.parse([
        { ip: "192.0.2.10", nameserver: "ns1." },
        { nameserver: "ns2." }, // missing ip
      ]),
    ).toThrow();
  });
});
