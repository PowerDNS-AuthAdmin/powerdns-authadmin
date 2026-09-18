/**
 * playwright.config.ts
 *
 * E2E tests in `tests/e2e/` run against a real built app (`npm run test:e2e`).
 * They cover the handful of behaviours that only reproduce in a browser -
 * hydration timing, autofill, WebAuthn ceremonies - which the Node-environment
 * unit suite and the Postgres integration suite structurally cannot reach.
 *
 * `webServer` builds and boots the app itself, reusing one that's already
 * listening outside CI. Specs must not depend on seeded accounts or leave
 * state behind; anything that needs a database belongs in the integration
 * suite instead.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_PORT"] ?? 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox + WebKit added when we have multi-browser parity to verify.
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
