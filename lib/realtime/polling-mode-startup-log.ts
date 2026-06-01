/**
 * lib/realtime/polling-mode-startup-log.ts
 *
 * Boot-time one-shot: when `PDNS_BACKGROUND_POLLING=false` (default) AND the
 * configured backend fleet looks like it would benefit from polling (≥1
 * configured cluster, OR ≥1 backend already observed as a secondary mirror),
 * print a clearly-formatted hint pointing operators at the env flag. Runs at
 * most once per process; subsequent calls are fast no-ops.
 *
 * Hard 3s budget so a slow Postgres can't block startup. Failures (timeout,
 * query error) are swallowed silently - the worst case is "we didn't print
 * the hint", which is strictly better than blocking the app.
 *
 * Triggered from the first `/healthz` hit (the same kick `instrumentation.ts`
 * uses to warm the rest of the app).
 */

import "server-only";
import { db } from "@/lib/db";
import { pdnsClusters, pdnsServers } from "@/lib/db/schema";
import { isReadOnlyMirror, isWriteCapable } from "@/lib/pdns/capabilities";
import { pdnsBackgroundPollingEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

let hasRun = false;
const BUDGET_MS = 3_000;

export async function logPollingModeOnce(): Promise<void> {
  if (hasRun) return;
  hasRun = true;

  // Honest case 1 - flag is on. Confirm it so operators see we picked it up.
  if (pdnsBackgroundPollingEnabled) {
    logger.info(
      "[startup] PDNS_BACKGROUND_POLLING=true - background poller scheduled; sync awareness, " +
        "dashboard PDNS metrics, per-zone Sync + Statistics, drift advisories are ALL ENABLED.",
    );
    return;
  }

  // Flag is off. Probe the configured topology (DB only, no PDNS calls) to
  // detect a multi-peer setup that would meaningfully benefit from polling,
  // then surface a single sharp log line. 3s budget protects boot.
  const probe = (async () => {
    const [servers, clusters] = await Promise.all([
      db.select().from(pdnsServers),
      db.select().from(pdnsClusters),
    ]);
    const activeServers = servers.filter((s) => s.disabledAt === null);
    const mirrors = activeServers.filter((s) => isReadOnlyMirror(s.capabilities)).length;
    const writers = activeServers.filter((s) => isWriteCapable(s.capabilities)).length;
    const clusterCount = clusters.length;
    return { activeServers: activeServers.length, mirrors, writers, clusterCount };
  })();

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS));

  try {
    const result = await Promise.race([probe, timeout]);
    if (result === null) {
      // Budget burned - silently give up. Better to start unhinted than hold the app.
      return;
    }
    const multiPeer = result.mirrors > 0 || result.clusterCount > 0 || result.writers > 1;
    if (multiPeer) {
      logger.warn(
        {
          servers: result.activeServers,
          mirrors: result.mirrors,
          writers: result.writers,
          clusters: result.clusterCount,
        },
        "[startup] PDNS_BACKGROUND_POLLING=false but the configured fleet has replication " +
          "topology (mirrors / multiple primaries / clusters). Sync awareness, drift advisories, " +
          "the per-zone Sync + Statistics tabs, and the dashboard PDNS metrics are HIDDEN. " +
          "Set PDNS_BACKGROUND_POLLING=true and restart to enable them.",
      );
    } else {
      logger.info(
        "[startup] PDNS_BACKGROUND_POLLING=false - single-server / standalone mode. PDNS " +
          "is contacted only in response to user actions; supplementary sync features hidden. " +
          "This is the recommended default for single-instance deployments.",
      );
    }
  } catch {
    // Probe failed (e.g. DB still warming) - silently skip; healthz will run
    // again on the next probe but `hasRun` is already true and won't re-fire.
    // That's by design: a one-shot startup log mustn't spam on every health
    // tick if the DB stays unhappy.
  }
}
