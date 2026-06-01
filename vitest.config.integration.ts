/**
 * vitest.config.integration.ts
 *
 * Vitest config for the HTTP-driven integration suite under
 * `tests/integration/`. Tests in this suite talk to a running app + PDNS
 * stack over the network - they do NOT import lib/* code. The runner
 * script `tests/integration/run.sh` builds + boots the test stack and
 * then invokes vitest with this config.
 *
 * Why separate from the unit config:
 *   - Different setup file (sanity-pings the stack before tests start).
 *   - Longer timeouts (a single API call can take 200+ ms when it
 *     fans out to a real PDNS).
 *   - Sequential execution (`fileParallelism: false`) - every test file
 *     shares the same Postgres DB, so file-level parallelism would race on
 *     resets. Each test starts with `await resetState()` regardless.
 *     (vitest 4 dropped `poolOptions.forks.singleFork`; `fileParallelism:
 *     false` is the supported way to serialize files.)
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/integration/helpers/**", "tests/integration/_legacy/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Serialize test files (shared Postgres DB). vitest 4 removed
    // `poolOptions`; `fileParallelism: false` is the supported equivalent.
    fileParallelism: false,
    server: {
      deps: {
        external: [/^pg($|\/|-)/],
      },
    },
  },
});
