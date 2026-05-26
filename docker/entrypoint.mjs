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
 * The three boot stages run pre-bundled ESM files under `./boot/`,
 * produced by `scripts/build-boot.mjs` at image-build time. Each bundle
 * carries its transitive `lib/*` imports inline; only the externals
 * named in the bundler config (native bindings, pg, pino transports)
 * stay dynamic, and those live in the standalone bundle's own
 * node_modules. No `tsx`, no source-tree at runtime — that was the
 * single biggest contributor to the previous image size.
 */

import { spawnSync } from "node:child_process";

function runStep(label, scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: process.env,
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
  runStep("migrate", "./boot/migrate.js");
}

const skipSeed = (process.env.SEED_ON_BOOT ?? "").toLowerCase() === "false";
if (skipSeed) {
  console.log("[entrypoint] SEED_ON_BOOT=false — skipping seed");
} else {
  console.log("[entrypoint] running seed (system roles + bootstrap admin)");
  runStep("seed", "./boot/seed.js");
}

const skipProvision = (process.env.PROVISION_ON_BOOT ?? "").toLowerCase() === "false";
const provisioningFile = process.env.PROVISIONING_FILE;
if (skipProvision) {
  console.log("[entrypoint] PROVISION_ON_BOOT=false — skipping provisioning");
} else if (!provisioningFile) {
  console.log("[entrypoint] PROVISIONING_FILE not set — skipping provisioning");
} else {
  console.log("[entrypoint] running first-boot provisioning");
  runStep("provision", "./boot/provision.js");
}

console.log("[entrypoint] starting Next.js server");
await import("./server.js");
