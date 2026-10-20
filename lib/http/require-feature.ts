/**
 * lib/http/require-feature.ts
 *
 * Route guard for the opt-in fleet checks (`optionalFeatures` in lib/env.ts).
 * A disabled feature answers 404, the same as a route that does not exist:
 * nothing about it is reachable, and nothing reveals that it could be turned on.
 */

import { optionalFeatures } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";

export function requireFeature(feature: keyof typeof optionalFeatures): void {
  if (!optionalFeatures[feature]) throw new NotFoundError("Not found.");
}
