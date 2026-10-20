/**
 * lib/monitoring/external-ptr.ts
 *
 * What the rest of the world answers for addresses the installation cannot
 * host a PTR for. The Reverse DNS page lists such addresses as "not hosted";
 * this module looks their PTR up through recursive resolvers so the operator
 * still sees whether the ISP's or cloud provider's reverse record names the
 * host - and whether it needs a ticket upstream.
 *
 * Horizon-aware: a public address is asked of the public resolvers, an
 * internal one of the internal resolvers (or the host's own resolver when none
 * are configured). Lookups are spread across the interval rather than fired
 * in one burst, cached per address, and a manual refresh is rate-limited.
 */

import "server-only";
import { promises as dns } from "node:dns";
import { reverseOwnerName } from "@/lib/dns/reverse-name";
import { query } from "@/lib/dns/wire";
import type { ZoneHorizon } from "@/lib/dns/zone-horizon";
import { zoneMonitorConfig } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface ExternalPtr {
  ip: string;
  horizon: ZoneHorizon;
  /** Targets the resolver answered; empty = no PTR. */
  targets: string[];
  rcode: string | null;
  resolver: string | null;
  checkedAt: string;
  error?: string;
}

interface State {
  timer: NodeJS.Timeout | null;
  results: Map<string, ExternalPtr>;
  queue: Map<string, ZoneHorizon>;
  inFlight: Promise<void> | null;
  lastManualAt: number;
}

declare global {
  var __externalPtr: State | undefined;
}
const state: State = (globalThis.__externalPtr ??= {
  timer: null,
  results: new Map(),
  queue: new Map(),
  inFlight: null,
  lastManualAt: 0,
});

const CONCURRENCY = 2;
const QUERY_TIMEOUT_MS = 3000;
export const MANUAL_REFRESH_INTERVAL_MS = 60_000;

async function lookupOne(ip: string, horizon: ZoneHorizon): Promise<ExternalPtr> {
  const owner = reverseOwnerName(ip);
  const checkedAt = new Date().toISOString();
  if (!owner)
    return {
      ip,
      horizon,
      targets: [],
      rcode: null,
      resolver: null,
      checkedAt,
      error: "not an address",
    };
  const resolvers =
    horizon === "public" ? zoneMonitorConfig.publicResolvers : zoneMonitorConfig.internalResolvers;
  if (resolvers.length === 0) {
    // No configured resolver for this horizon: the host's own resolver decides.
    try {
      const targets = await dns.reverse(ip);
      return {
        ip,
        horizon,
        targets: targets.map((t) => `${t.toLowerCase().replace(/\.$/, "")}.`),
        rcode: "NOERROR",
        resolver: "system",
        checkedAt,
      };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "ENOTFOUND" || code === "ENODATA")
        return {
          ip,
          horizon,
          targets: [],
          rcode: code === "ENOTFOUND" ? "NXDOMAIN" : "NOERROR",
          resolver: "system",
          checkedAt,
        };
      return {
        ip,
        horizon,
        targets: [],
        rcode: null,
        resolver: "system",
        checkedAt,
        error: code || "lookup failed",
      };
    }
  }
  let lastError = "no resolver answered";
  for (const resolver of resolvers) {
    try {
      const msg = await query(owner, "PTR", {
        server: resolver,
        recursion: true,
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      const targets = msg.answer.filter((r) => r.type === "PTR").map((r) => r.data);
      return { ip, horizon, targets, rcode: msg.rcodeName, resolver, checkedAt };
    } catch (err) {
      lastError = `${resolver}: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }
  return { ip, horizon, targets: [], rcode: null, resolver: null, checkedAt, error: lastError };
}

async function drain(): Promise<void> {
  const items = [...state.queue.entries()];
  state.queue.clear();
  if (items.length === 0) return;
  const spacingMs = Math.min(5_000, (zoneMonitorConfig.externalPtrIntervalMs * 0.5) / items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const [ip, horizon] = items[next++]!;
        try {
          state.results.set(ip, await lookupOne(ip, horizon));
        } catch (err) {
          logger.warn(
            { ip, error: err instanceof Error ? err.message : "unknown" },
            "external-ptr.lookup.failed",
          );
        }
        if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
      }
    }),
  );
}

function run(): Promise<void> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = drain().finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

/**
 * Remember which addresses need an external answer and make sure the periodic
 * lookup is running. Called by the Reverse DNS report with its unhosted rows;
 * an address not yet looked up is queued for the next pass.
 */
export function scheduleExternalLookups(
  addresses: ReadonlyArray<{ ip: string; horizon: ZoneHorizon }>,
): void {
  if (!zoneMonitorConfig.enabled) return;
  for (const a of addresses) {
    const prev = state.results.get(a.ip);
    const stale =
      !prev || Date.now() - Date.parse(prev.checkedAt) > zoneMonitorConfig.externalPtrIntervalMs;
    if (stale) state.queue.set(a.ip, a.horizon);
  }
  if (!state.timer) {
    state.timer = setInterval(() => void run(), zoneMonitorConfig.externalPtrIntervalMs);
    setTimeout(() => void run(), 2_000);
  }
}

export function getExternalPtr(ip: string): ExternalPtr | null {
  return state.results.get(ip) ?? null;
}

/** Operator-triggered lookup of every queued/known address now. Rate-limited. */
export async function refreshExternalNow(
  addresses: ReadonlyArray<{ ip: string; horizon: ZoneHorizon }>,
): Promise<boolean> {
  if (!zoneMonitorConfig.enabled) return false;
  if (Date.now() - state.lastManualAt < MANUAL_REFRESH_INTERVAL_MS) return false;
  state.lastManualAt = Date.now();
  for (const a of addresses) state.queue.set(a.ip, a.horizon);
  await run();
  return true;
}
