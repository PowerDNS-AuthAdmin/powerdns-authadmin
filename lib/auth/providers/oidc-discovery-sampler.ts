/**
 * lib/auth/providers/oidc-discovery-sampler.ts
 *
 * On-access discovery freshness sampler for OIDC providers.
 * The probe in `oidc-probe.ts` (T-72) is operator-triggered via the
 * Test button; before this sampler the `discoveryCache` on a provider
 * row only refreshed when an admin clicked Test or edited the
 * provider. This module adds passive refresh: every load of
 * `/admin/auth-providers/oidc` re-probes any provider whose cache is
 * older than `staleMs` (default 15 minutes), in parallel, best-
 * effort. The dashboard's "PDNS attention" widget pattern (T-82)
 * mirrored: stale rows surface as red, fresh rows green.
 *
 * Why on-access rather than a background cron: same reasoning as
 * `lib/metrics/sampler.ts` — Phase-1/2 ops are kept simple (no
 * BullMQ worker yet). The OIDC providers list is the only surface
 * that reads the data, so sampling on its load is "fresh enough."
 * A real BullMQ / Prometheus scheduler is future work.
 *
 * Failure handling: per-provider try/catch. One unreachable IdP
 * must not stall a page render that lists ten of them. Probe
 * errors are written back as `ok=false` cache entries so the
 * discovery badge reflects the attempt rather than going silent —
 * "tried 3m ago, failed: transport error" beats "last seen 2h ago,
 * still showing green because we stopped trying."
 */

import "server-only";
import { setOidcDiscoveryCache } from "@/lib/db/repositories/oidc-providers";
import { listEnabledOidcProviders } from "@/lib/db/repositories/oidc-providers";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { isDiscoveryCacheStale } from "./oidc-discovery-staleness";
import { probeOidcDiscovery } from "./oidc-probe";
import { checkOidcIssuerUrlSafe } from "./oidc-url-safety";

const DEFAULT_STALE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Re-probe every enabled provider whose discoveryCache is stale.
 * Probes run in parallel; the worst-case wait is one PROBE_TIMEOUT
 * (~5s from oidc-probe), not N × that. Returns the number of
 * providers actually re-probed (0 when nothing was due).
 *
 * Always safe to call: failures are caught per-provider, never
 * thrown, never block the caller's page render.
 *
 * `fetchImpl` defaults to global fetch; tests inject a mock to
 * drive probe outcomes deterministically (T-108).
 */
export async function ensureFreshOidcDiscovery(
  staleMs = DEFAULT_STALE_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const providers = await listEnabledOidcProviders();
  const stale = providers.filter((p) => isDiscoveryCacheStale(p.discoveryCache, staleMs));
  if (stale.length === 0) return 0;

  await Promise.all(stale.map((p) => sampleOneProvider(p, fetchImpl)));
  return stale.length;
}

/** Force-probe every enabled provider regardless of cache freshness. */
export async function sampleAllOidcDiscoveryNow(fetchImpl: typeof fetch = fetch): Promise<number> {
  const providers = await listEnabledOidcProviders();
  await Promise.all(providers.map((p) => sampleOneProvider(p, fetchImpl)));
  return providers.length;
}

async function sampleOneProvider(
  provider: {
    id: string;
    slug: string;
    issuerUrl: string;
  },
  fetchImpl: typeof fetch,
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  try {
    // Explicit SSRF pre-check before probing — defense-in-depth (the pinned
    // fetch inside `probeOidcDiscovery` re-checks too) and a clean
    // transport-style failure when the persisted issuer now resolves to a
    // blocked address. Mirrors the `/test` route.
    const safety = await checkOidcIssuerUrlSafe(provider.issuerUrl);
    const result = safety.safe
      ? await probeOidcDiscovery(provider.issuerUrl, fetchImpl)
      : ({ ok: false, reason: "transport" } as const);
    await setOidcDiscoveryCache(provider.id, {
      fetchedAt,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
    });
  } catch (err) {
    // probeOidcDiscovery already classifies its own failures and
    // returns a typed result — reaching this catch means something
    // unusual (DB write below, fetch impl threw an unexpected
    // shape, etc). Log + try to record a "transport" failure so
    // the cache still moves forward.
    logger.warn(
      {
        providerSlug: provider.slug,
        error: err instanceof Error ? redact(err.message) : "unknown",
      },
      "oidc.discovery.sample.failed",
    );
    try {
      await setOidcDiscoveryCache(provider.id, {
        fetchedAt,
        ok: false,
        reason: "transport",
      });
    } catch (writeErr) {
      // DB write failure on the failure path — swallow. The outer
      // log captured the original error; double-logging adds noise
      // without information.
      void writeErr;
    }
  }
}
