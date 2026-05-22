/**
 * docker/entrypoint.mjs
 *
 * Boot-time entrypoint for the runner container. Four stages, then
 * hands off to the Next.js standalone server:
 *
 *   1. Migrations (ADR-0011)             — opt out: MIGRATE_ON_BOOT=false
 *   2. Seed (system roles + bootstrap)   — opt out: SEED_ON_BOOT=false
 *                                          (bootstrap admin needs
 *                                          BOOTSTRAP_ADMIN_EMAIL +
 *                                          BOOTSTRAP_ADMIN_PASSWORD)
 *   3. First-boot provisioning (ADR-0012)— opt out: PROVISION_ON_BOOT=false
 *                                          or PROVISIONING_FILE unset
 *   4. Next.js server boot
 *
 * Any stage failure aborts the boot — a broken migrate, seed, or
 * malformed provisioning file produces a refused start, not a degraded run.
 *
 * Why we run the .ts sources via `tsx` instead of pre-compiling to JS:
 * the rest of the codebase uses bundler-style imports (no .js extensions,
 * `@/*` path aliases) that the Next.js build accepts natively. Compiling
 * those modules to Node-runnable JS with `tsc --module nodenext` triggers
 * a rewrite of every relative import in the tree, which costs more churn
 * than the boot scripts are worth. `tsx` reads the existing tsconfig +
 * source files and transpiles on the fly — single-digit-MB extra in the
 * image, no compile step in the Dockerfile.
 */

import { spawnSync } from "node:child_process";

const TSX_CLI = "./node_modules/tsx/dist/cli.mjs";

function runStep(label, scriptPath) {
  const env = { ...process.env };
  // tsx needs the `react-server` condition to resolve the server-only
  // marker module the same way Next.js does at app runtime; otherwise the
  // ESM-only `client.js` export wins and any `import "server-only"` in
  // the boot scripts' transitive imports throws.
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--conditions=react-server"].filter(Boolean).join(" ");
  const result = spawnSync(process.execPath, [TSX_CLI, scriptPath], {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    console.error(`[entrypoint] ${label}.spawn-failed:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[entrypoint] ${label} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const skipMigrate = (process.env.MIGRATE_ON_BOOT ?? "").toLowerCase() === "false";
if (skipMigrate) {
  console.log("[entrypoint] MIGRATE_ON_BOOT=false — skipping migrations");
} else {
  console.log("[entrypoint] running DB migrations");
  runStep("migrate", "./scripts/migrate.ts");
}

const skipSeed = (process.env.SEED_ON_BOOT ?? "").toLowerCase() === "false";
if (skipSeed) {
  console.log("[entrypoint] SEED_ON_BOOT=false — skipping seed");
} else {
  console.log("[entrypoint] running seed (system roles + bootstrap admin)");
  runStep("seed", "./scripts/seed.ts");
}

const skipProvision = (process.env.PROVISION_ON_BOOT ?? "").toLowerCase() === "false";
const provisioningFile = process.env.PROVISIONING_FILE;
if (skipProvision) {
  console.log("[entrypoint] PROVISION_ON_BOOT=false — skipping provisioning");
} else if (!provisioningFile) {
  console.log("[entrypoint] PROVISIONING_FILE not set — skipping provisioning");
} else {
  console.log("[entrypoint] running first-boot provisioning");
  runStep("provision", "./scripts/provision.ts");
}

console.log("[entrypoint] starting Next.js server");
await import("./server.js");
