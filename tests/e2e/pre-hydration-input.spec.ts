/**
 * tests/e2e/pre-hydration-input.spec.ts
 *
 * Regression test for #139: credentials typed before the client bundle
 * loaded must still reach the server.
 *
 * The login page is server-rendered, so its form is interactive well before
 * React hydrates. Input that lands in that window is in the DOM and nowhere
 * else - controlled state never sees it. The form used to serialise that
 * state, so a visitor on a cold cache POSTed `{"email":"","password":""}`,
 * got "Invalid request body." back, and watched both fields blank out.
 *
 * Delaying the chunk responses turns a timing-dependent bug into a
 * deterministic one: the typing below always finishes first.
 *
 * Deliberately uses credentials that don't exist. The assertion is about what
 * leaves the browser, not about signing in, so this needs no seeded account
 * and writes nothing.
 */

import { expect, test } from "@playwright/test";

const HYDRATION_DELAY_MS = 4000;
const EMAIL = "pre-hydration@example.test";
const PASSWORD = "not-a-real-password";

test("login submits credentials typed before hydration", async ({ page }) => {
  await page.route("**/_next/static/chunks/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
    await route.continue();
  });

  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/login") && response.request().method() === "POST",
  );

  // `domcontentloaded`, not `load` - the point is to type while the bundle
  // the form depends on is still in flight.
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);

  // Let hydration land on the already-filled fields before submitting.
  await page.waitForTimeout(HYDRATION_DELAY_MS * 2);
  await page.click("button[type=submit]");

  const response = await loginResponse;

  const sent = response.request().postDataJSON() as { email?: string; password?: string };
  expect(sent.email).toBe(EMAIL);
  expect(sent.password).toBe(PASSWORD);

  // Asserted on the response rather than on-screen text: the credentials are
  // fictional, so the only outcome ruled out is the 400 an empty body earns.
  // Anything else (401 here) means the server got a real pair to reject.
  expect(response.status()).not.toBe(400);

  // The fields keep what was typed; the failed submit must not blank them.
  await expect(page.locator("#email")).toHaveValue(EMAIL);
});
