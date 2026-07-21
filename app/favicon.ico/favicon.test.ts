import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET, ICON_SVG } from "./route";

/**
 * `app/icon.svg` is the icon Next injects into <head>; `ICON_SVG` is the copy
 * this route serves at the legacy `/favicon.ico` path. The copy exists because
 * the standalone production image ships no source `app/` directory to read
 * from - so the only thing keeping them honest is this test.
 */
describe("/favicon.ico", () => {
  it("serves markup byte-identical to app/icon.svg", async () => {
    const onDisk = await readFile(path.join(process.cwd(), "app", "icon.svg"), "utf8");
    // Strip the explanatory comment and trailing newline - they're for readers
    // of the file, not bytes the route needs to reproduce.
    const stripped = onDisk.replace(/<!--[\s\S]*?-->/g, "").trim();
    expect(stripped).toBe(ICON_SVG);
  });

  it("responds 200 with a non-empty SVG body", async () => {
    const res = GET();
    // Specifically NOT 204: a null-body status here broke Next's prerender
    // cache and then threw from the Response constructor on replay.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("draws the mark with paths, not font-dependent <text>", () => {
    // Safari and Firefox resolved font-family="monospace" differently in the
    // favicon rasterizer, so the glyph rendered inconsistently. Paths carry
    // their own geometry.
    expect(ICON_SVG).toContain("<path");
    expect(ICON_SVG).not.toContain("<text");
    expect(ICON_SVG).not.toContain("font-family");
  });
});
