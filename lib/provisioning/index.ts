/**
 * lib/provisioning/index.ts
 *
 * Public entry point: load the YAML file, parse + validate, apply, audit.
 * Wraps `apply.ts` with the file IO + Zod plumbing.
 */

import "server-only";
import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { logger } from "@/lib/logger";
import { applyProvisioning, isProvisioned, type ProvisioningResult } from "./apply";
import { provisioningSchema } from "./schema";

export { isProvisioned, type ProvisioningResult } from "./apply";

export interface RunProvisioningOptions {
  /** Path to the YAML file. */
  filePath: string;
  /**
   * When true, run the applier even if the database already has the
   * provisioned-at sentinel. Useful for tests and for operator-driven
   * "re-apply" workflows. Default false.
   */
  force?: boolean;
}

export type RunProvisioningOutcome =
  | { status: "applied"; result: ProvisioningResult }
  | { status: "skipped"; reason: "already-provisioned" };

/**
 * Top-level provisioning runner. Returns "skipped" when the sentinel is
 * present and `force` is not set; "applied" otherwise.
 */
export async function runProvisioning(
  opts: RunProvisioningOptions,
): Promise<RunProvisioningOutcome> {
  if (!opts.force && (await isProvisioned())) {
    logger.info({ filePath: opts.filePath }, "provisioning.skipped.sentinel-present");
    return { status: "skipped", reason: "already-provisioned" };
  }

  const raw = readFileSync(opts.filePath, "utf8");
  const parsed: unknown = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`provisioning: ${opts.filePath} did not parse to a YAML object.`);
  }

  const validated = provisioningSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  • ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`provisioning: ${opts.filePath} failed schema validation.\n${issues}`);
  }

  logger.info(
    {
      filePath: opts.filePath,
      sections: {
        settings: !!validated.data.settings,
        roles: validated.data.roles?.length ?? 0,
        teams: validated.data.teams?.length ?? 0,
        zone_templates: validated.data.zone_templates?.length ?? 0,
        pdns_servers: validated.data.pdns_servers?.length ?? 0,
        oidc: validated.data.oidc?.length ?? 0,
      },
    },
    "provisioning.applying",
  );

  const result = await applyProvisioning(validated.data);
  logger.info({ result }, "provisioning.applied");
  return { status: "applied", result };
}
