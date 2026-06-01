import Link from "next/link";
import { freshnessOf } from "@/lib/freshness";
import { displayZoneName } from "@/lib/dns/zone-name";
import type { PdnsZoneDetail } from "@/lib/pdns/types";
import type { ZoneAuditEntry } from "@/lib/db/repositories/audit-log";
import { CloneZoneButton } from "./clone-zone-button";
import { ZoneRealtimeSubscriber } from "./zone-realtime-subscriber";
import { PollingDisabledHint } from "@/components/domain/polling-disabled-hint";

interface ZoneHeaderProps {
  /**
   * Cached sync verdict (primary vs secondaries). Drives the realtime
   * indicator into fast-poll mode while replication is in flight. `null`
   * when `PDNS_BACKGROUND_POLLING=false` - the header chip stays in plain
   * "Live" mode and the subscriber only refreshes on mutation events.
   */
  inSync: boolean | null;
  zone: PdnsZoneDetail;
  zoneIdEncoded: string;
  /**
   * The concrete server this view reads/writes through. For cluster
   * targets it's the cluster's representative peer (any peer suffices
   * because the backend is replicated).
   */
  server: { name: string; slug: string };
  /**
   * When set, the zone is being viewed through a cluster context - the
   * UI surfaces the cluster name (not the peer's) in the backend
   * caption and uses `?cluster=` on internal links so navigation stays
   * cluster-aware.
   */
  cluster: { name: string; slug: string } | null;
  lastEdit: Pick<ZoneAuditEntry, "ts" | "actorEmail" | "actorType"> | null;
  canReadAudit: boolean;
  canCreateZone: boolean;
}

export function ZoneHeader({
  zone,
  zoneIdEncoded,
  server,
  cluster,
  lastEdit,
  canReadAudit,
  canCreateZone,
  inSync,
}: ZoneHeaderProps) {
  const backLink = "/zones";
  const historyHref = cluster
    ? `/zones/${zoneIdEncoded}?cluster=${encodeURIComponent(cluster.slug)}&tab=history`
    : `/zones/${zoneIdEncoded}?server=${encodeURIComponent(server.slug)}&tab=history`;
  const nonSoaCount = (zone.rrsets ?? []).filter((rr) => rr.type !== "SOA").length;
  const isPrimary = zone.kind === "Master" || zone.kind === "Primary";

  return (
    <>
      <div>
        <Link href={backLink} className="text-sm text-[color:var(--color-accent)] hover:underline">
          ← Back to zones
        </Link>
      </div>

      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {displayZoneName(zone.name)}
          </h1>
          <ZoneRealtimeSubscriber zoneName={zone.name} inSync={inSync} />
          {inSync === null ? <PollingDisabledHint /> : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Kind" value={zone.kind} />
          <Stat label="Serial" value={String(zone.serial ?? "-")} />
          <Stat label="Edited serial" value={String(zone.edited_serial ?? "-")} />
          <Stat label="DNSSEC" value={zone.dnssec ? "on" : "off"} />
        </dl>
        {canReadAudit ? (
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            {lastEdit ? (
              <>
                <span className="font-medium text-[color:var(--color-fg)]">Last edit:</span>{" "}
                {freshnessOf(lastEdit.ts.toISOString()).label}
                {lastEdit.actorEmail ? (
                  <>
                    {" by "}
                    <span className="font-mono">{lastEdit.actorEmail}</span>
                  </>
                ) : lastEdit.actorType === "system" ? (
                  <> by system</>
                ) : null}
                {" - "}
                <Link
                  href={historyHref}
                  className="text-[color:var(--color-accent)] hover:underline"
                >
                  see history
                </Link>
              </>
            ) : (
              <>No edits recorded yet for this zone.</>
            )}
          </p>
        ) : null}
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Backend: {cluster ? `${cluster.name} (cluster · via peer ${server.name})` : server.name} ·{" "}
          {nonSoaCount} RRset{nonSoaCount === 1 ? "" : "s"}
          {isPrimary ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.65rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              auto-notify on edit
            </span>
          ) : null}
        </p>
        {canCreateZone ? <CloneZoneButton sourceName={zone.name} serverSlug={server.slug} /> : null}
      </header>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
