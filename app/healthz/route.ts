/**
 * app/healthz/route.ts
 *
 * Liveness probe. Returns 200 as long as the process is up and accepting requests.
 * It must NOT check downstream dependencies — that's what `/readyz` is for. A
 * failing liveness probe should mean "kill this pod"; a failing readiness probe
 * should mean "stop sending traffic to this pod."
 *
 * Kubernetes, Docker Healthcheck, and load balancers should all use this for
 * liveness checks.
 *
 * Side effect: every probe also calls `ensurePollerRunning()`. The call is
 * idempotent (no-op when the timer is live) but updates the heartbeat used
 * by idle-shutdown — so as long as something is hitting `/healthz` (Docker
 * checks every 15 s by default), the zone poller stays running even when
 * nobody is logged in. This is what plugs the dashboard's overnight data
 * gap; the instrumentation hook fires the first hit so the poller starts
 * on boot without waiting for the first external probe.
 */

import { ensurePollerRunning } from "@/lib/realtime/zone-poller";
import { logPollingModeOnce } from "@/lib/realtime/polling-mode-startup-log";

export const dynamic = "force-dynamic";

export function GET(): Response {
  ensurePollerRunning();
  // One-shot hint about the polling mode + topology mismatch (if any).
  // Fire-and-forget with a hard 3s internal budget — never blocks the probe.
  void logPollingModeOnce();
  return Response.json(
    { status: "ok", service: "powerdns-authadmin" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
