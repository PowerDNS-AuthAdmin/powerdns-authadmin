/**
 * tests/integration/helpers/reset.ts
 *
 * Glue between db.ts + pdns.ts. Most tests want both DB user-data and
 * upstream PDNS zone state wiped between cases - `resetState()` does both
 * in parallel.
 *
 * Per-test usage:
 *
 *   import { beforeEach } from "vitest";
 *   import { resetState } from "../helpers/reset";
 *   beforeEach(() => resetState());
 */

import { resetUserData } from "./db";
import { wipeAllZones } from "./pdns";
import { BOOTSTRAP_EMAIL } from "./auth";

export interface ResetOptions {
  /** Skip PDNS zone cleanup when the test doesn't touch backends. */
  skipPdns?: boolean;
  /** Skip DB cleanup when a test wants to layer onto previous state (rare). */
  skipDb?: boolean;
}

export async function resetState(opts: ResetOptions = {}): Promise<void> {
  const work: Array<Promise<unknown>> = [];
  if (!opts.skipDb) work.push(resetUserData({ bootstrapEmail: BOOTSTRAP_EMAIL }));
  if (!opts.skipPdns) work.push(wipeAllZones());
  await Promise.all(work);
}
