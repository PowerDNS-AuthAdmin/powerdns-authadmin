#!/usr/bin/env node
/**
 * scripts/screenshots.mjs
 *
 * Playwright-driven screenshot regen for /screenshots and the root README.
 * Captures every page in `PAGES` × `{ light, dark } × { desktop, mobile }`.
 *
 * Output:
 *   - screenshots/<theme>/<name>.png         (1440×900 viewport, full bleed)
 *   - screenshots/<theme>/<name>-mobile.png  (iPhone 14 screenshot wrapped in
 *                                             a CSS-rendered iPhone bezel —
 *                                             showcase-grade marketing asset)
 *
 * Prereqs:
 *   - The combined demo stack is up:
 *       docker compose -f docker-compose-combined.yml up -d --build
 *     (needs APP_SECRET_KEY + APP_ENCRYPTION_KEY env)
 *   - The bootstrap admin's must_change_password is cleared:
 *       docker exec powerdns-authadmin-combined-postgres-1 \
 *         psql -U pdns -d powerdns_authadmin \
 *         -c "UPDATE users SET must_change_password=false WHERE email='admin@example.com';"
 *
 * Usage:
 *   npm run screenshots                                            # full sweep
 *   node scripts/screenshots.mjs --pages=zones-list,audit-log      # subset
 *   node scripts/screenshots.mjs zones-list audit-log              # subset (positional)
 *   PAGES_FILTER=zones-list,audit-log npm run screenshots          # subset (env)
 *   SKIP_MOBILE=1 npm run screenshots                              # desktop only
 *   SKIP_DESKTOP=1 npm run screenshots                             # mobile only
 *
 * Env knobs:
 *   SCREENSHOT_URL       default http://localhost:3000
 *   SCREENSHOT_EMAIL     default admin@example.com
 *   SCREENSHOT_PASSWORD  default bootstrap-admin-pw-changeme
 *                        (the BOOTSTRAP_ADMIN_PASSWORD baked into
 *                        docker-compose-combined.yml)
 *   SHOWCASE_ZONE        default ps-6.demo. (used for zone-detail / change
 *                        history / edit-dialog / review-changes diff shots)
 *   SHOWCASE_CLUSTER     default ps-group (cluster slug for the showcase zone)
 *   PAGES_FILTER         comma-separated subset of page names (empty = all)
 *   SKIP_MOBILE / SKIP_DESKTOP   "1" to skip that half of the sweep
 *   SKIP_OPTIMIZE        "1" to skip the post-pass PNG optimizer
 *
 * Optional but strongly recommended:
 *   - pngquant  (lossy, quality 80-95 — visually identical for UI shots)
 *   - oxipng    (lossless restream)
 * Install both with `brew install pngquant oxipng` (or apt/dnf equivalent).
 * The sweep skips the optimizer silently if neither is on PATH; with both
 * installed it shrinks the gallery by ~70 %.
 */
import { chromium, devices } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const BASE = process.env.SCREENSHOT_URL ?? "http://localhost:3000";
const EMAIL = process.env.SCREENSHOT_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.SCREENSHOT_PASSWORD ?? "bootstrap-admin-pw-changeme";
// Showcase zone for the per-zone shots. ps-6.demo is a primary+secondaries
// group zone (cluster slug `ps-group`) — picked because it renders the
// richest mix of data: a records table with multiple rrset types, a change
// history tab populated by the demo seed, and a sync chip with peers to
// compare against. Override via env if you point the script at a custom
// stack with different seeded zones.
const SHOWCASE_ZONE = process.env.SHOWCASE_ZONE ?? "ps-6.demo.";
const SHOWCASE_CLUSTER = process.env.SHOWCASE_CLUSTER ?? "ps-group";
const ZONE_PATH = `/zones/${encodeURIComponent(SHOWCASE_ZONE)}?cluster=${encodeURIComponent(SHOWCASE_CLUSTER)}`;
const ZONE_HISTORY_PATH = `${ZONE_PATH}&tab=history`;

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
// iPhone 16 Pro logical viewport (393 × 852). Playwright's device list tops
// out at iPhone 15 Pro Max, so we base on that descriptor and override the
// viewport to match a 16 Pro. The CSS frame below adds the 16-era hardware
// cues (Action button replacing the mute switch, Camera Control on the
// right) so the shot reads as a current-generation device.
const MOBILE_VIEWPORT = { width: 393, height: 852 };
const MOBILE_DEVICE = {
  ...devices["iPhone 15 Pro"],
  viewport: MOBILE_VIEWPORT,
};

/**
 * Pages to shoot. Every entry produces 4 variants — desktop+light,
 * desktop+dark, mobile+light, mobile+dark — so the docs reference a
 * consistent set for each page.
 *
 * Each entry has a `path` (navigated to first) and may have an async
 * `prepare(page)` callback that runs AFTER the navigation + settle and
 * BEFORE the screenshot. Use `prepare` to open dialogs, click into tabs,
 * or otherwise drive the UI into the state the shot needs to capture.
 */
const PAGES = [
  { name: "dashboard", path: "/dashboard" },
  { name: "zones-list", path: "/zones" },
  { name: "zone-detail", path: ZONE_PATH },
  {
    name: "zone-change-history",
    path: ZONE_HISTORY_PATH,
    async prepare(page) {
      // Expand the FIRST visible change-log entry so the BEFORE/AFTER
      // diff is in frame. Scoped to `[data-change-entry-toggle]` so we
      // don't accidentally hit the hamburger / health-bell / other
      // collapsibles that also use `aria-expanded`. The responsive
      // overlay has BOTH the desktop table and the mobile card list in
      // the DOM at once — only the visible form factor's toggle is
      // clicked, the hidden one is left alone.
      await page.evaluate(() => {
        const toggles = document.querySelectorAll(
          '[data-change-entry-toggle][aria-expanded="false"]',
        );
        for (const t of toggles) {
          let visible = true;
          let cur = t;
          while (cur && cur !== document.body) {
            if (getComputedStyle(cur).display === "none") {
              visible = false;
              break;
            }
            cur = cur.parentElement;
          }
          if (visible) {
            t.click();
            return;
          }
        }
      });
      await page.waitForTimeout(250);
      // Scroll to the bottom of the (now-taller, with expanded panels)
      // document so pagination + the latest expanded entry are framed.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(250);
    },
  },
  {
    name: "zone-edit",
    path: ZONE_PATH,
    async prepare(page) {
      // Click the first row's "Edit" button — opens the Edit-record dialog.
      await page.getByRole("button", { name: "Edit" }).first().click();
      await page.getByRole("heading", { name: "Edit record" }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(200);
    },
  },
  {
    name: "zone-edit-diff",
    path: ZONE_PATH,
    async prepare(page) {
      await page.getByRole("button", { name: "Edit" }).first().click();
      await page.getByRole("heading", { name: "Edit record" }).waitFor({ timeout: 5_000 });
      // Append a digit to the Value field so the diff has something to show.
      // Inputs in DOM order are [Name, TTL, Value]; the Type selector is a
      // SelectMenu button (not <input>) and the "Disabled" / "Save anyway"
      // controls are type=checkbox. Filter those out → Value is index 2.
      const dialog = page.getByRole("dialog");
      const valueInput = dialog.locator('input:not([type="checkbox"])').nth(2);
      await valueInput.click();
      await page.keyboard.press("End");
      await page.keyboard.type("2");
      await page.getByRole("button", { name: "Review changes" }).click();
      await page.getByRole("heading", { name: "Review changes" }).waitFor({ timeout: 5_000 });
      await page.waitForTimeout(200);
    },
  },
  {
    name: "backend-health",
    path: "/dashboard",
    async prepare(page) {
      // The bell's aria-label is "Backend health: N active issue(s)" — match
      // by prefix so the exact count doesn't matter.
      await page.getByRole("button", { name: /^Backend health:/ }).click();
      await page.waitForTimeout(300);
    },
  },
  { name: "powerdns-servers", path: "/admin/servers" },
  { name: "users", path: "/admin/users" },
  { name: "teams", path: "/admin/teams" },
  { name: "roles", path: "/admin/roles" },
  { name: "audit-log", path: "/admin/audit" },
  { name: "pdns-requests", path: "/admin/pdns-requests" },
  { name: "oidc-providers", path: "/admin/oidc-providers" },
  { name: "tsig-keys", path: "/admin/tsig-keys" },
  { name: "autoprimaries", path: "/admin/autoprimaries" },
  { name: "zone-templates", path: "/admin/zone-templates" },
  { name: "settings", path: "/admin/settings" },
  { name: "profile", path: "/profile" },
];

/**
 * Page selection sources, merged in this order (later wins):
 *   1. PAGES_FILTER env var ("a,b,c")
 *   2. `--pages=a,b,c` CLI flag
 *   3. positional args (`node screenshots.mjs a b c`)
 * Empty result → run every page.
 */
function selectedPages() {
  const fromEnv = (process.env.PAGES_FILTER ?? "").trim();
  const allow = new Set();
  if (fromEnv) for (const n of fromEnv.split(",")) if (n.trim()) allow.add(n.trim());
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--pages=")) {
      for (const n of arg.slice("--pages=".length).split(",")) if (n.trim()) allow.add(n.trim());
    } else if (!arg.startsWith("-")) {
      // Bare positional like `node screenshots.mjs zone-change-history`.
      allow.add(arg.trim());
    }
  }
  if (allow.size === 0) return PAGES;
  return PAGES.filter((p) => allow.has(p.name));
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function settle(page) {
  // The realtime SSE stream keeps `networkidle` from ever firing, so we use
  // `domcontentloaded` + a fixed settle instead. 1.2 s is long enough for the
  // SSE chip to switch from CONNECTING to CONNECTED and for cached-zone
  // tables to render their first rows.
  await page.waitForTimeout(1_200);
}

async function applyFontOverride(page) {
  // Playwright's bundled Chromium falls back to a wider hyphen glyph for
  // `ui-monospace` than system Chromium does — force a literal font stack
  // so zone names like `ps-6.demo` render with a normal hyphen, not the
  // em-dash-looking glyph the bundled font would otherwise produce.
  await page.addStyleTag({
    content: `.font-mono, code, kbd, samp, pre { font-family: "Menlo", "Consolas", "Liberation Mono", "Courier New", monospace !important; }`,
  });
  await page.waitForTimeout(120);
}

async function shootDesktop(page, theme, def) {
  await page.goto(`${BASE}${def.path}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (def.prepare) await def.prepare(page);
  await applyFontOverride(page);
  const dir = `screenshots/${theme}`;
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${def.name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  ✓ ${out}`);
}

/**
 * Mobile shots: take the raw 390×844 webpage screenshot, then re-screenshot
 * it inside a CSS-rendered iPhone 14 Pro bezel. The OS status bar (time +
 * carrier/wifi/battery icons + dynamic island) sits ABOVE the webpage
 * content — the island does not encroach into the page viewport, matching a
 * real device's layout. All Playwright + CSS, no extra deps.
 */
async function shootMobile(page, framePage, theme, def) {
  await page.goto(`${BASE}${def.path}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (def.prepare) await def.prepare(page);
  await applyFontOverride(page);
  const raw = await page.screenshot({ fullPage: false });
  const base64 = raw.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;
  await renderIphoneFrame(framePage, dataUrl, theme);
  const dir = `screenshots/${theme}`;
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${def.name}-mobile.png`);
  await framePage.locator("#frame").screenshot({ path: out, omitBackground: true });
  console.log(`  ✓ ${out}`);
}

async function renderIphoneFrame(framePage, screenDataUrl, theme) {
  // Frame proportions tuned to an iPhone 16 Pro (393 × 852 logical) with the
  // OS status bar stacked above the webpage so the Dynamic Island never
  // covers page content.
  //   - Webpage area: 393 × 852
  //   - Status bar (with Dynamic Island): 50 px
  //   - Screen total: 393 × 902
  //   - Bezel: 11 px each side (slimmer than 14-era) → frame 415 × 924
  //   - Corner radii: 56 px outer, 45 px inner — nested-radius bezel.
  //   - Hardware cues: Action Button (left, replaces mute switch) and
  //     Camera Control (right, slightly recessed wide pill, iPhone 16+).
  const isDark = theme === "dark";
  const statusFg = isDark ? "#f0f0f0" : "#0a0a0a";
  const statusBg = isDark ? "#0a0a0a" : "#ffffff";
  const html = `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { padding: 28px; display: inline-block; }
  #frame {
    width: 415px;
    height: 924px;
    background: #0a0a0c;
    border-radius: 56px;
    padding: 11px;
    box-sizing: border-box;
    box-shadow:
      0 0 0 1.5px #1c1c20,
      0 30px 60px -20px rgba(0,0,0,0.45),
      0 12px 30px -10px rgba(0,0,0,0.35);
    position: relative;
  }
  #screen {
    width: 393px;
    height: 902px;
    border-radius: 45px;
    overflow: hidden;
    position: relative;
    background: ${statusBg};
  }
  #statusbar {
    height: 50px;
    background: ${statusBg};
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 26px 0 30px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: ${statusFg};
    position: relative;
    z-index: 2;
  }
  #statusbar .icons { display: inline-flex; align-items: center; gap: 6px; }
  #island {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    width: 100px;
    height: 32px;
    border-radius: 18px;
    background: #050505;
    z-index: 3;
  }
  #screen img {
    display: block;
    width: 393px;
    height: 852px;
  }
  /* Hardware buttons — iPhone 16 / 16 Pro layout. */
  .btn { position: absolute; background: #1c1c20; border-radius: 2px; }
  .btn-left  { left:  -2px; width: 3px; }
  .btn-right { right: -2px; width: 3px; }
  /* Action Button — replaces the mute switch from iPhone 14 era. */
  .btn-action  { top: 105px; height: 34px; }
  .btn-volup   { top: 165px; height: 60px; }
  .btn-voldn   { top: 235px; height: 60px; }
  /* Power / Sleep. */
  .btn-power   { top: 175px; height: 92px; }
  /* Camera Control — the recessed wide pill new on iPhone 16. */
  .btn-camera  {
    top: 305px;
    height: 42px;
    width: 4px;
    background: linear-gradient(to right, #2a2a2e 50%, #1c1c20 50%);
  }
  /* SF-style status-bar icons rendered as SVG paths. */
  svg { display: block; }
</style></head><body>
  <div id="frame">
    <span class="btn btn-left  btn-action"></span>
    <span class="btn btn-left  btn-volup"></span>
    <span class="btn btn-left  btn-voldn"></span>
    <span class="btn btn-right btn-power"></span>
    <span class="btn btn-right btn-camera"></span>
    <div id="screen">
      <div id="statusbar">
        <span class="time">9:41</span>
        <span class="icons">
          <!-- signal -->
          <svg width="18" height="11" viewBox="0 0 18 11" fill="currentColor">
            <rect x="0"  y="7" width="3" height="4" rx="0.5"/>
            <rect x="5"  y="5" width="3" height="6" rx="0.5"/>
            <rect x="10" y="3" width="3" height="8" rx="0.5"/>
            <rect x="15" y="0" width="3" height="11" rx="0.5"/>
          </svg>
          <!-- wifi -->
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M2 4.5 a9 9 0 0 1 12 0"/>
            <path d="M4 7 a6 6 0 0 1 8 0"/>
            <path d="M6 9.5 a3 3 0 0 1 4 0"/>
            <circle cx="8" cy="11" r="0.9" fill="currentColor" stroke="none"/>
          </svg>
          <!-- battery -->
          <svg width="26" height="12" viewBox="0 0 26 12" fill="none">
            <rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke="currentColor" stroke-opacity="0.5"/>
            <rect x="2" y="2" width="19" height="8" rx="1.5" fill="currentColor"/>
            <rect x="23" y="4" width="1.8" height="4" rx="0.9" fill="currentColor" fill-opacity="0.5"/>
          </svg>
        </span>
      </div>
      <div id="island"></div>
      <img src="${screenDataUrl}" />
    </div>
  </div>
</body></html>`;
  await framePage.setContent(html, { waitUntil: "domcontentloaded" });
}

async function runDesktopPass(browser, theme) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    colorScheme: theme,
  });
  await context.addInitScript((t) => {
    window.localStorage.setItem("pda-theme", t);
  }, theme);
  const page = await context.newPage();
  console.log(`[${theme}/desktop] login`);
  await login(page);
  for (const def of selectedPages()) {
    try {
      await shootDesktop(page, theme, def);
    } catch (err) {
      console.error(`  ✗ ${def.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  await context.close();
}

async function runMobilePass(browser, theme) {
  // Two contexts: the mobile one drives the actual app at 390×844; a
  // separate desktop-sized one renders the iPhone-frame HTML and re-shoots.
  const mobileCtx = await browser.newContext({ ...MOBILE_DEVICE, colorScheme: theme });
  await mobileCtx.addInitScript((t) => {
    window.localStorage.setItem("pda-theme", t);
  }, theme);
  const mobilePage = await mobileCtx.newPage();

  const frameCtx = await browser.newContext({
    viewport: { width: 480, height: 990 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const framePage = await frameCtx.newPage();

  console.log(`[${theme}/mobile] login`);
  await login(mobilePage);
  for (const def of selectedPages()) {
    try {
      await shootMobile(mobilePage, framePage, theme, def);
    } catch (err) {
      console.error(`  ✗ ${def.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  await mobileCtx.close();
  await frameCtx.close();
}

/**
 * Optional post-pass: shrink every PNG with `pngquant` (lossy at q=80-95,
 * visually identical for UI screenshots) and then `oxipng -o 4` (lossless
 * deflate restream). Brings the gallery from ~11 MB → ~3 MB. Both tools
 * are optional — if neither is installed we skip the pass and only log a
 * hint. Run `SKIP_OPTIMIZE=1` to bypass even when they're available.
 */
function optimizePngs() {
  if (process.env.SKIP_OPTIMIZE === "1") return;
  const dirs = ["screenshots/light", "screenshots/dark"];
  const hasPngquant = spawnSync("pngquant", ["--version"], { stdio: "ignore" }).status === 0;
  const hasOxipng = spawnSync("oxipng", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasPngquant && !hasOxipng) {
    console.log(
      "optimize: skipped — neither pngquant nor oxipng on PATH. " +
        "Install with `brew install pngquant oxipng` (or apt/dnf equivalents) " +
        "to shrink the gallery by ~70%.",
    );
    return;
  }
  // Glob each dir; spawnSync with shell expansion keeps it portable enough.
  if (hasPngquant) {
    console.log("optimize: pngquant (quality 80-95) on every png");
    for (const dir of dirs) {
      spawnSync(
        "sh",
        [
          "-c",
          `for f in ${dir}/*.png; do pngquant --quality=80-95 --skip-if-larger --output "$f.opt" --force "$f" 2>/dev/null && mv "$f.opt" "$f"; done`,
        ],
        { stdio: "inherit" },
      );
    }
  }
  if (hasOxipng) {
    console.log("optimize: oxipng -o 4 --strip safe (lossless restream)");
    const files = dirs.flatMap((d) => [`${d}/*.png`]);
    spawnSync("sh", ["-c", `oxipng -o 4 --strip safe ${files.join(" ")}`], { stdio: "inherit" });
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    if (process.env.SKIP_DESKTOP !== "1") {
      await runDesktopPass(browser, "light");
      await runDesktopPass(browser, "dark");
    }
    if (process.env.SKIP_MOBILE !== "1") {
      await runMobilePass(browser, "light");
      await runMobilePass(browser, "dark");
    }
  } finally {
    await browser.close();
  }
  optimizePngs();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
