/**
 * scripts/build-boot.mjs
 *
 * Bundles the three boot-time TS scripts (`migrate`, `seed`, `provision`)
 * into self-contained Node ESM files under `./boot/`. The runner image
 * runs these JS files directly with `node` — no `tsx`, no `scripts/`
 * source tree, no `lib/` source tree, no separate prod-deps `node_modules`
 * — which was the single biggest contributor to the runner image size
 * (the deps stage was a ~700 MB on-disk overlay used only by boot).
 *
 * Run as part of the image build (`npm run build:boot` in the builder
 * stage, after `npm run build`).
 *
 * Externals — kept dynamic, NOT inlined:
 *
 *   • Native `.node` bindings can't be inlined into JS (they load at
 *     runtime via dlopen). We keep `better-sqlite3` and `@node-rs/argon2`
 *     external; their .node binaries live in the standalone bundle's
 *     own node_modules (Next traces them for the app runtime).
 *
 *   • `pg`'s `Pool extends EventEmitter` survives CJS round-tripping
 *     inside Node natively but breaks under esbuild's ESM interop
 *     ("Class extends value is not a constructor"). Tiny package, leave
 *     it external.
 *
 *   • Pino loads worker JS files from its own package directory via
 *     `__dirname`; the workers can't be inlined into a single ESM
 *     bundle. Leave the pino transport tree external.
 *
 * Module resolution: at runtime the bundled files live at /app/boot/.
 * Node walks up looking for node_modules, finds /app/node_modules/ —
 * which IS the Next.js standalone bundle's traced subset. Every external
 * listed above is present there because Next traced them for the app.
 *
 * Conditions mirror Next's at app runtime (`react-server`, `node`, …)
 * so `import "server-only"` resolves to its server build, the same way
 * Next.js sees it.
 */

import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "boot");

rmSync(outdir, { recursive: true, force: true });

// `server-only` and `client-only` are marker modules that throw at import
// time when imported from the wrong React environment. Boot scripts have
// no client/server split — a noop module is correct here. We generate it
// in a build-cache directory so the bundler can resolve it without the
// `tests/` tree being in the Docker build context.
const cacheDir = resolve(root, ".build-cache");
mkdirSync(cacheDir, { recursive: true });
const noopPath = resolve(cacheDir, "server-client-only-noop.js");
writeFileSync(noopPath, "export {};\n");

await build({
  entryPoints: {
    migrate: "scripts/migrate.ts",
    seed: "scripts/seed.ts",
    provision: "scripts/provision.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  minify: process.env.BOOT_BUNDLE_NO_MINIFY === "1" ? false : true,
  sourcemap: process.env.BOOT_BUNDLE_NO_MINIFY === "1" ? "inline" : false,
  alias: {
    "@": root,
    "server-only": noopPath,
    "client-only": noopPath,
  },
  conditions: ["react-server", "node", "import", "default"],
  external: [
    // Native .node bindings — dlopen at runtime.
    "better-sqlite3",
    "@node-rs/argon2",
    "pg-native",
    "@next/swc-*",
    // CJS interop holdouts.
    "pg",
    // Pino transport tree — workers loaded from package dir via __dirname.
    "pino",
    "pino-pretty",
    "pino-std-serializers",
    "thread-stream",
    "sonic-boom",
    "real-require",
    "atomic-sleep",
  ],
  // ESM-of-CJS-deps occasionally hits a leftover `require()` from
  // upstream packages. Make `require` available at the top of every
  // bundled module so those resolve via Node's regular CJS path.
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "info",
  absWorkingDir: root,
});

console.log(`[build-boot] wrote bundles to ${outdir}`);
