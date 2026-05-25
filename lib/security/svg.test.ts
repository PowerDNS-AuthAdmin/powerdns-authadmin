/**
 * lib/security/svg.test.ts — issue #30
 */

import { describe, expect, it } from "vitest";
import { sanitizeSvg, sanitizeBrandLogoValue } from "./svg";

describe("sanitizeSvg", () => {
  it("strips <script> elements and their content", () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("strips <foreignObject> (can host HTML/JS)", () => {
    const out = sanitizeSvg('<svg><foreignObject><body onload="x()"/></foreignObject></svg>');
    expect(out).not.toMatch(/foreignObject/i);
  });

  it("removes on* event-handler attributes (quoted + unquoted)", () => {
    expect(sanitizeSvg("<svg onload=\"evil()\"><rect onclick='go()'/></svg>")).not.toMatch(
      /\son\w+=/i,
    );
    expect(sanitizeSvg("<svg onload=evil()></svg>")).not.toMatch(/\son\w+=/i);
  });

  it("neutralizes javascript: and external href/xlink:href to '#'", () => {
    const out = sanitizeSvg(
      '<svg><a href="javascript:alert(1)"><a xlink:href="https://evil.test/x"/></a></svg>',
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/https?:\/\/evil/i);
    expect(out).toMatch(/href="#"/);
  });

  it("leaves a clean SVG untouched", () => {
    const clean =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1"/></svg>';
    // The xmlns is an attribute value, not an href, so it must survive.
    expect(sanitizeSvg(clean)).toBe(clean);
  });
});

describe("sanitizeBrandLogoValue", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const decodeB64Svg = (uri: string) =>
    Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

  it("sanitizes a base64 data:image/svg+xml payload, re-encoded as base64", () => {
    const dirty = `data:image/svg+xml;base64,${b64("<svg><script>alert(1)</script><path/></svg>")}`;
    const out = sanitizeBrandLogoValue(dirty);
    expect(out.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = decodeB64Svg(out);
    expect(decoded).not.toMatch(/<script/i);
    expect(decoded).toContain("<path/>");
  });

  it("leaves raster data: URIs unchanged", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(sanitizeBrandLogoValue(png)).toBe(png);
  });

  it("leaves http(s) URLs unchanged (including https-hosted SVG)", () => {
    const url = "https://cdn.example.com/logo.svg";
    expect(sanitizeBrandLogoValue(url)).toBe(url);
  });
});
