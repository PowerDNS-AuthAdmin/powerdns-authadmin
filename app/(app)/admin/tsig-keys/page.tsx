/**
 * app/(app)/admin/tsig-keys/page.tsx
 *
 * Per-backend inventory of TSIG keys. Lists name + algorithm only -
 * **never** the shared-secret material, which is reserved for a
 * future reveal flow gated on `tsig.manage`.
 *
 * Permission: `tsig.read`. Operators with `tsig.manage` additionally
 * see (in a later tick) buttons to reveal a key's secret, generate
 * a new key, and delete keys.
 *
 * Backend selection: pass `?server=<slug>` to inspect a non-default
 * backend (matches the convention used by the zones list and
 * /admin/servers detail pages).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findServerToInspect, listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { listEligibleTsigKeys } from "@/lib/realtime/tsig-eligibility";
import { listPrimarySecondaries } from "@/lib/realtime/tsig-replication";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { derivedParentOf } from "@/lib/pdns/topology-cache";
import { isServerWriteTarget } from "@/lib/pdns/capabilities";
import { stripTrailingDot } from "@/lib/pdns/tsig";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { PdnsAuthError } from "@/lib/pdns/errors";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { TsigActions } from "./_components/tsig-actions";
import { TsigKeysReadOnly } from "./_components/tsig-keys-readonly";

const PRIMARY_KINDS = new Set(["master", "primary"]);

export const metadata: Metadata = { title: "TSIG keys" };

interface PageProps {
  searchParams: Promise<{ server?: string }>;
}

export default async function TsigKeysPage({ searchParams }: PageProps) {
  const { ability } = await requireUserForPage({ can: "tsig.read" });
  const canManage = ability.can("manage", "Tsig");
  const { server: requestedSlug } = await searchParams;

  const selected = await findServerToInspect(requestedSlug);
  const servers = await listAllPdnsServers();

  if (selected?.disabledAt !== null) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">TSIG keys</h1>
        </header>
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>No backend selected.</strong> Add a server under{" "}
          <Link href="/admin/servers" className="underline">
            /admin/servers
          </Link>{" "}
          first.
        </div>
      </div>
    );
  }

  let keys: Awaited<ReturnType<typeof loadKeys>> | null = null;
  let fetchError: string | null = null;
  try {
    keys = await loadKeys(selected);
  } catch (err) {
    // The gateway already recorded reachability; show a generic message (the raw
    // connect error host:port is a fingerprint oracle - S-12 - log-only).
    fetchError =
      err instanceof PdnsAuthError
        ? "API rejected the configured key (401/403)."
        : "Backend unreachable - the app hasn't reached its API recently.";
    logger.warn(
      { server: selected.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
      "admin.tsig.list.failed",
    );
  }

  // Replication targets: API install only makes sense when inspecting a primary.
  // Zone correlation is primary-owned, but secondaries should still display and
  // edit the same primary-side domain list as a convenience reference.
  const isPrimary = isServerWriteTarget(selected);
  let installSecondaries: Array<{ slug: string; name: string; supportsTsigApi: boolean }> = [];
  let correlationServer: { slug: string; name: string } | null = null;
  let correlationZones: string[] = [];
  let keyUsage = new Map<string, { zoneCount: number; zones: string[] }>();
  await ensureBackendsObserved();
  const correlationPrimary = resolveCorrelationPrimary(selected, servers);
  if (correlationPrimary) {
    correlationServer = { slug: correlationPrimary.slug, name: correlationPrimary.name };
    if (canManage && selected.id === correlationPrimary.id) {
      installSecondaries = (await listPrimarySecondaries(selected)).map((s) => ({
        slug: s.slug,
        name: s.name,
        supportsTsigApi: !!s.versionCache?.capabilities.supportsTsigApi,
      }));
    }
    correlationZones = [...(readCachedZones(correlationPrimary.id)?.zones.values() ?? [])]
      .filter((z) => PRIMARY_KINDS.has(z.kind.toLowerCase()))
      .map((z) => z.name)
      .sort();
    if (keys) {
      const usage = await listEligibleTsigKeys({
        keyHosts: [correlationPrimary],
        zoneHosts: [correlationPrimary],
      });
      keyUsage = new Map(usage.map((u) => [u.name, { zoneCount: u.zoneCount, zones: u.zones }]));
    }
  }

  const sorted = keys
    ? [...keys]
        .map((key) => {
          const usage = keyUsage.get(stripTrailingDot(key.name));
          return {
            ...key,
            zoneCount: usage?.zoneCount ?? 0,
            zones: usage?.zones ?? [],
            canEditZones: usage !== undefined,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">TSIG keys</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Shared HMAC secrets used to authenticate AXFR / IXFR / NOTIFY between primaries and
          secondaries.
        </p>
      </header>

      {servers.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-xs">
          {servers
            .filter((s) => s.disabledAt === null)
            .map((s) => (
              <Link
                key={s.id}
                href={`/admin/tsig-keys?server=${encodeURIComponent(s.slug)}`}
                className={
                  s.slug === selected.slug
                    ? "rounded border border-[color:var(--color-accent)] bg-[color:var(--color-accent)] px-2 py-1 text-[color:var(--color-accent-fg)]"
                    : "rounded border border-[color:var(--color-border)] px-2 py-1 hover:bg-[color:var(--color-bg-muted)]"
                }
              >
                {s.name}
              </Link>
            ))}
        </nav>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          <strong>Could not list TSIG keys.</strong>
          <p className="mt-1 text-xs">{fetchError}</p>
        </div>
      ) : null}

      {canManage ? (
        // Key on the slug so switching backends remounts the component - the
        // one-time secret is per-server and must NOT carry across a server
        // switch (a soft `?server=` nav otherwise preserves its client state).
        // `rows={sorted}` is null on a fetch error (the error box above covers
        // that case); [] renders the empty "no data" row inside the table.
        <TsigActions
          key={selected.slug}
          serverSlug={selected.slug}
          rows={sorted}
          isPrimary={isPrimary}
          secondaries={installSecondaries}
          correlationServer={correlationServer}
          zones={correlationZones}
        />
      ) : fetchError ? null : (
        <TsigKeysReadOnly serverSlug={selected.slug} rows={sorted ?? []} />
      )}
    </div>
  );
}

async function loadKeys(selected: Awaited<ReturnType<typeof findServerToInspect>> & object) {
  const client = getBackendGateway(selected);
  return client.listTsigKeys();
}

function resolveCorrelationPrimary(
  selected: NonNullable<Awaited<ReturnType<typeof findServerToInspect>>>,
  servers: Awaited<ReturnType<typeof listAllPdnsServers>>,
) {
  if (isServerWriteTarget(selected)) return selected;

  const active = servers.filter((s) => s.disabledAt === null);
  const derivedParentId = derivedParentOf(selected.id);
  const derivedParent = derivedParentId
    ? active.find((s) => s.id === derivedParentId && isServerWriteTarget(s))
    : null;
  if (derivedParent) return derivedParent;

  if (selected.clusterId) {
    const peers = active.filter(
      (s) => s.clusterId === selected.clusterId && isServerWriteTarget(s),
    );
    if (peers.length === 1) return peers[0]!;
  }

  return null;
}
