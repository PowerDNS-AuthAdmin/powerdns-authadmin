/**
 * lib/security/svg.test.ts — issue #30
 *
 * Asserts security properties of the DOMPurify-backed sanitizer (DOMPurify
 * normalizes markup, so we assert on what's stripped/kept, not exact strings).
 */

import { describe, expect, it } from "vitest";
import { sanitizeSvg, sanitizeBrandLogoValue } from "./svg";

describe("sanitizeSvg", () => {
  it("strips <script> but keeps drawing content", () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toMatch(/<path[^>]*d="M0 0"/);
  });

  it("strips <foreignObject> (can host HTML/JS)", () => {
    const out = sanitizeSvg('<svg><foreignObject><body onload="x()"/></foreignObject></svg>');
    expect(out).not.toMatch(/foreignobject/i);
    expect(out).not.toMatch(/<body/i);
  });

  it("removes on* event-handler attributes", () => {
    expect(sanitizeSvg('<svg onload="evil()"><rect onclick="go()"/></svg>')).not.toMatch(
      /\son\w+=/i,
    );
  });

  it("drops javascript: links", () => {
    const out = sanitizeSvg('<svg><a href="javascript:alert(1)"><rect/></a></svg>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it("keeps a clean SVG's drawing content", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1"/></svg>',
    );
    expect(out).toMatch(/<svg/i);
    expect(out).toMatch(/<path[^>]*d="M1 1"/);
    expect(out).not.toMatch(/<script|onload=|javascript:/i);
  });
});

describe("sanitizeBrandLogoValue", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const decodeB64Svg = (uri: string) =>
    Buffer.from(uri.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

  it("sanitizes a base64 data:image/svg+xml payload, re-encoded as base64", () => {
    const dirty = `data:image/svg+xml;base64,${b64('<svg><script>alert(1)</script><path d="M0 0"/></svg>')}`;
    const out = sanitizeBrandLogoValue(dirty);
    expect(out.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = decodeB64Svg(out);
    expect(decoded).not.toMatch(/<script/i);
    expect(decoded).toMatch(/<path[^>]*d="M0 0"/);
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
