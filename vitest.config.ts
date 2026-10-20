/**
 * vitest.config.ts
 *
 * Configures Vitest for unit tests. Unit tests live next to the source file
 * (`foo.ts` + `foo.test.ts`) per CONTRIBUTING.md § Testing.
 *
 * Integration tests (which require a live Postgres and a fake PDNS) use a separate
 * config - `vitest.config.integration.ts` - that adds globalSetup hooks for Docker
 * Compose. That file lands when the first integration test does.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// fileURLToPath, not `.pathname`: a checkout under a directory with a space in
// its name would otherwise alias `server-only` to a `%20` path that does not
// exist, and every server-only module would fail to load.
const root = fileURLToPath(new URL("./", import.meta.url));

const alias = {
  "@/": root,
  // `server-only` / `client-only` only exist to throw when imported from
  // the wrong React environment. Tests have no RSC/client split, so stub
  // them out. (An alias is robust even though @vitejs/plugin-react flips
  // Vite to client-resolution, which defeats the react-server condition.)
  "server-only": `${root}tests/noop-module.ts`,
  "client-only": `${root}tests/noop-module.ts`,
};

const EXCLUDE = [
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  // Agent worktrees live here (git worktree under .claude/worktrees); their
  // copies of the test files must not be collected into the main run.
  ".claude/**",
  "tests/integration/**",
  "tests/e2e/**",
];

/** Tests that render React into a document: `foo.dom.test.tsx`. */
const DOM_TESTS = "**/*.dom.test.tsx";

export default defineConfig({
  // tsconfig sets `jsx: "preserve"` (Next.js transforms JSX itself), which
  // Vite's esbuild can't parse. The React plugin transforms `.tsx` ahead of
  // Vite's import analysis so component imports work in tests.
  plugins: [react()],
  test: {
    // Two projects because the two kinds of unit test need opposite React
    // builds. Plain tests resolve with the `react-server` condition so
    // `server-only` modules load; DOM tests render through `react-dom/client`,
    // which that condition replaces with a stub that throws, so they resolve
    // as a browser bundle would and run in jsdom.
    projects: [
      {
        plugins: [react()],
        // `react-server` condition makes the `server-only` package resolve to
        // its no-op server build instead of the throwing client guard. Mirrors
        // what the `db:seed` npm script does at the process level - keeps
        // `npm test` green without operators having to remember the
        // NODE_OPTIONS dance.
        resolve: { alias, conditions: ["react-server", "node", "import", "default"] },
        test: {
          name: "node",
          environment: "node",
          setupFiles: ["./tests/setup.ts"],
          include: ["**/*.test.ts", "**/*.test.tsx"],
          exclude: [...EXCLUDE, DOM_TESTS],
          // Test files run in worker threads in parallel. Set to `false` if a
          // test suite needs a serial DB connection.
          pool: "threads",
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias, conditions: ["browser", "import", "default"] },
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./tests/setup.ts"],
          include: [DOM_TESTS],
          exclude: EXCLUDE,
          pool: "threads",
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
    ],
    // We don't gate global coverage - it's dominated by UI + repository code
    // that's exercised by the Postgres integration suite, not the unit suite.
    // Instead we floor the security-critical, DB-free modules that MUST stay
    // unit-tested: auth primitives, crypto, RBAC. CI runs `npm run test`
    // (= `vitest run --coverage`), so a drop below these floors fails the build.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["lib/**", "app/**", "components/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/index.ts", "**/README.md", "**/types.ts"],
      thresholds: {
        "lib/crypto/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "lib/rbac/**": { statements: 70, branches: 60, functions: 85, lines: 70 },
        // lib/auth/** spans the unit-tested primitives (password, totp, csrf,
        // rate-limit) AND the DB/network-backed providers (OIDC) covered by the
        // integration suite - so this floor sits below the others and just
        // guards against a sharp unit-coverage regression.
        "lib/auth/**": { statements: 40, branches: 40, functions: 45, lines: 40 },
      },
    },
  },
});
