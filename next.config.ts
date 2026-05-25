/**
 * next.config.ts
 *
 * Next.js framework configuration. Kept minimal on purpose — security headers live in
 * `middleware.ts` so they apply per-request with a per-request CSP nonce, not as
 * statically-baked `headers()` entries.
 *
 * Reasoning: a static CSP would force `'unsafe-inline'` for scripts (because Next's
 * hydration data is inline), which defeats most of the value of CSP. The middleware
 * approach issues a fresh nonce on every request and threads it through to Next's
 * inline scripts via the `nonce` mechanism Next 15 supports natively.
 */

import type { NextConfig } from "next";

const config: NextConfig = {
  // Next 16 removed the built-in ESLint integration (`next lint`), so there's
  // no `eslint` config key anymore — linting runs only via `npm run lint`.

  // `npm run typecheck` runs as a separate CI step.
  // We pay for one type-check pass, not two.
  typescript: { ignoreBuildErrors: false },

  // React strict mode catches double-renders and effect lifecycle bugs in development.
  reactStrictMode: true,

  // Disable the `X-Powered-By: Next.js` header — no fingerprinting our stack to attackers.
  poweredByHeader: false,

  // Use the standalone output for the Docker image — produces a minimal `server.js`
  // and a focused `node_modules` tree, ~80% smaller than full output.
  output: "standalone",

  // External packages that should not be bundled by the server build (native bindings,
  // dynamic `require('fs'|'path')`, optional deps). Drizzle's pg driver is the classic
  // case; better-sqlite3 ships a `.node` binding via `bindings` (which itself requires
  // `fs`/`path`); pg pulls `pgpass` + `pg-connection-string` which both touch `fs`/`path`.
  // Leaving them external keeps webpack out of their internals and lets the runtime
  // `require` them as plain Node modules from `./node_modules`.
  //
  // Note: this list does NOT apply to `instrumentation.ts` (Next 15 limitation —
  // tracked at vercel/next.js#53523), which is why we don't put runtime DB checks in
  // that file. The migrate script's own incomplete-migrations guard is the equivalent
  // safety net.
  serverExternalPackages: [
    "pg",
    "pg-connection-string",
    "pgpass",
    "better-sqlite3",
    "bindings",
    "file-uri-to-path",
    "pino",
    "pino-pretty",
    "undici",
    "echarts",
  ],

  experimental: {
    // Tighter inline-script CSP via per-request nonces. Required for `middleware.ts` to thread
    // the nonce into Next's framework scripts.
    // See: https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy

    // Disable Next's client-side router cache for dynamic RSC payloads.
    // Without this, navigating between tabs (zone Records → Change history → back)
    // serves a cached RSC payload for up to 30 s — making the page look frozen and
    // hiding the loading shimmer. PDNS state can change between tab switches; we
    // want a live fetch every time.
    //
    // We only override `dynamic`; `static` is left at Next's default. Next 16
    // clamps `staleTimes.static` to a minimum of 30 s and silently ignores a
    // lower value (the old `static: 0` was a no-op), so leaving the key out is
    // honest about what actually takes effect. Prefetched static RSC payloads
    // keep caching, so plain link prefetching still works.
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default config;
