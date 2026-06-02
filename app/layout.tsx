/**
 * app/layout.tsx
 *
 * The root layout - wraps every page in the app. Sets up:
 *   - The <html> element (lang, suppressHydrationWarning for theme-swapping)
 *   - Global CSS import (Tailwind + design tokens)
 *   - Default metadata (overridden per-page)
 *   - A pre-hydration script that applies the user's saved theme BEFORE
 *     React mounts - prevents flash-of-wrong-theme.
 *
 * Per-page or per-route-group concerns (auth requirement, dashboard chrome) live
 * in nested `layout.tsx` files inside `(app)/`, `(auth)/`, etc.
 *
 * Default export is required by Next.js App Router - see eslint.config.mjs for
 * the exception this file is granted.
 */

import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getAppSettings } from "@/lib/settings/app-settings";
import "./globals.css";

/**
 * Dynamic metadata so the `site_name` setting flows into the browser tab
 * and the OG title. Falls back to the hard-coded default when the DB read
 * fails (see lib/settings/app-settings.ts). Cached per request by Next.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { siteName } = await getAppSettings();
  return {
    title: { default: siteName, template: `%s - ${siteName}` },
    description: "Self-hosted DNS administration UI for PowerDNS.",
    // Favicon is the static `app/icon.svg`, auto-injected by Next.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

/**
 * Pre-hydration theme initializer. Runs before React mounts, applies the
 * user's saved choice (or follows the OS preference) by toggling the `.dark`
 * class on <html>. Carries the per-request CSP nonce so it survives our
 * strict CSP (see ADR 0006).
 *
 * Source is intentionally compact, defensive (try/catch around localStorage
 * which throws in private-mode Safari and when storage is blocked), and
 * doesn't depend on any framework code.
 */
const THEME_INIT_SCRIPT = `(function(){try{var k="pda-theme",t=localStorage.getItem(k)||"system",d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // CSP nonce is set per request in proxy.ts; thread it onto the inline
  // theme-init script so it isn't blocked by the strict policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
