/**
 * scripts/provision.ts
 *
 * First-boot IaC entry point. Reads `PROVISIONING_FILE`, applies it,
 * writes the sentinel. Idempotent — re-running with the sentinel present
 * is a no-op.
 *
 * Invocation:
 *   npm run provision                 # operator-driven
 *   docker/entrypoint.mjs (post-migrate, pre-server boot)
 *
 * Opt-out:
 *   PROVISION_ON_BOOT=false           # entrypoint skips this script
 *   PROVISIONING_FILE not set         # no-op (nothing to apply)
 *
 * Force re-apply:
 *   delete the `provisioned_at` row from `settings` and re-run.
 *
 * See ADR-0012 and `provisioning.example.yaml`.
 */

import { existsSync } from "node:fs";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { closeDatabase } from "@/lib/db";
import { runProvisioning } from "@/lib/provisioning";

async function main(): Promise<void> {
  const filePath = env.PROVISIONING_FILE;
  if (!filePath) {
    logger.info("provision.skipped: PROVISIONING_FILE not set");
    return;
  }
  if (!existsSync(filePath)) {
    logger.error({ filePath }, "provision.failed: file does not exist");
    process.exit(1);
  }

  const outcome = await runProvisioning({ filePath });
  if (outcome.status === "skipped") {
    logger.info({ filePath, reason: outcome.reason }, "provision.skipped");
  } else {
    logger.info({ filePath, result: outcome.result }, "provision.completed");
  }
}

// Exit explicitly — same reason as scripts/seed.ts: this runs as a one-shot
// boot step under docker/entrypoint.mjs's blocking spawnSync, and a lingering
// pool socket / pino transport worker would otherwise keep the process alive
// and hang the boot before the Next server starts.
main()
  .catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "provision.failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
    process.exit(process.exitCode ?? 0);
  });
