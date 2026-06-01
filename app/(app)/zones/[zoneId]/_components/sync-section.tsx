/**
 * Sync tab body - replication / consistency view for one zone.
 *
 * Two modes, identical layout, different wording:
 *
 *   • primary-secondaries: the zone is served by a Primary that NOTIFYs
 *     N Secondaries. Each Secondary is compared serial-to-serial AND
 *     record-for-record against the Primary. Anything off ⇒ in-flight
 *     or stalled replication.
 *
 *   • cluster: the zone is served by N peer Primaries sharing a
 *     replicated backend. There's no canonical Primary, so the peer
 *     with the highest serial becomes the anchor for the comparison
 *     (ties broken alphabetically). Any other peer whose content drifts
 *     ⇒ flagged. Per-user request: "highest serial would be regarded as
 *     source of truth here."
 */

import { compareZoneRecords, compareClusterPeerRecords } from "@/lib/pdns/sync";
import { BareDiff } from "./bare-diff";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsZoneDetail } from "@/lib/pdns/types";
import Link from "next/link";

type Props =
  | {
      mode: "primary-secondaries";
      primary: PdnsServer;
      zone: PdnsZoneDetail;
    }
  | {
      mode: "cluster";
      /** All active peers, including the one this view is reading from.
       *  The helper picks the highest-serial peer as the anchor - it
       *  doesn't have to be the one we currently render via. */
      peers: PdnsServer[];
      zoneName: string;
      /** The cluster, for the header copy + the empty-state link. */
      cluster: { id: string; name: string; slug: string };
    };

export function SyncSection(props: Props) {
  if (props.mode === "cluster") {
    return <ClusterSync {...props} />;
  }
  return <PrimarySecondariesSync {...props} />;
}

async function PrimarySecondariesSync({
  primary,
  zone,
}: {
  primary: PdnsServer;
  zone: PdnsZoneDetail;
}) {
  const diffs = await compareZoneRecords(primary, zone);
  if (diffs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
        No secondaries configured for <code className="font-mono">{primary.name}</code>. Add one on
        the{" "}
        <Link href={`/admin/servers/${primary.id}`} className="underline">
          server admin page
        </Link>{" "}
        to enable sync checks here.
      </div>
    );
  }

  return (
    <DiffList
      headerTitle={`Replication state (${diffs.length} secondar${diffs.length === 1 ? "y" : "ies"})`}
      headerSubtitle="Each secondary is compared serial-to-serial and record-for-record against the primary. Differences below the header mean replication is in flight or stalled."
      diffs={diffs.map((d) => ({
        ...d,
        // For the primary/secondaries mode the labels match what was
        // there before - primary serial / secondary serial.
        leftLabel: "primary serial",
        rightLabel: "secondary serial",
        synopsis: "All records match between primary and secondary.",
      }))}
    />
  );
}

async function ClusterSync({
  peers,
  zoneName,
  cluster,
}: {
  peers: PdnsServer[];
  zoneName: string;
  cluster: { id: string; name: string; slug: string };
}) {
  if (peers.length < 2) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
        Cluster <code className="font-mono">{cluster.name}</code> has fewer than two active peers -
        nothing to compare. Add a peer on the{" "}
        <Link href={`/admin/clusters/${cluster.slug}`} className="underline">
          cluster admin page
        </Link>{" "}
        to enable sync checks here.
      </div>
    );
  }

  const { anchor, diffs } = await compareClusterPeerRecords(peers, zoneName);

  return (
    <DiffList
      headerTitle={`Cluster sync (${peers.length} peers)`}
      headerSubtitle={
        <>
          Each peer is compared serial-to-serial and record-for-record against{" "}
          <code className="font-mono">{anchor.name}</code>, the highest-serial peer (used as
          source-of-truth when peers disagree). Drift below the header means a write hasn&apos;t
          propagated across all peers yet.
        </>
      }
      diffs={diffs.map((d) => ({
        ...d,
        leftLabel: "anchor serial",
        rightLabel: "peer serial",
        synopsis: "Peer matches the anchor exactly.",
      }))}
    />
  );
}

interface DiffWithLabels {
  server: PdnsServer;
  primarySerial: number | null;
  secondarySerial: number | null;
  onlyOnPrimary: string[];
  onlyOnSecondary: string[];
  error: string | null;
  leftLabel: string;
  rightLabel: string;
  synopsis: string;
}

function DiffList({
  headerTitle,
  headerSubtitle,
  diffs,
}: {
  headerTitle: string;
  headerSubtitle: React.ReactNode;
  diffs: DiffWithLabels[];
}) {
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          {headerTitle}
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{headerSubtitle}</p>
      </header>

      <ul className="space-y-4">
        {diffs.map((d) => {
          const inSync =
            d.error === null &&
            d.primarySerial === d.secondarySerial &&
            d.onlyOnPrimary.length === 0 &&
            d.onlyOnSecondary.length === 0;
          const tone = d.error
            ? "border-[color:var(--color-error)]"
            : inSync
              ? "border-[color:var(--color-success)]"
              : "border-[color:var(--color-warn)]";
          return (
            <li key={d.server.id} className={`overflow-hidden rounded-md border ${tone}`}>
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-xs">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link
                    href={`/admin/servers/${d.server.id}`}
                    className="font-medium text-[color:var(--color-accent)] hover:underline"
                  >
                    {d.server.name}
                  </Link>
                  <span className="text-[color:var(--color-fg-muted)]">{d.server.slug}</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-3 text-xs">
                  <span>
                    {d.leftLabel}: <code className="font-mono">{d.primarySerial ?? "-"}</code>
                  </span>
                  <span>
                    {d.rightLabel}: <code className="font-mono">{d.secondarySerial ?? "-"}</code>
                  </span>
                  <Badge
                    text={d.error ? "error" : inSync ? "synced" : "desynced"}
                    tone={
                      d.error
                        ? "error"
                        : inSync
                          ? "success"
                          : d.secondarySerial === null
                            ? "error"
                            : "warn"
                    }
                  />
                </div>
              </header>
              {d.error ? (
                <p className="px-4 py-3 text-xs text-[color:var(--color-error)]">{d.error}</p>
              ) : inSync ? (
                <p className="px-4 py-3 text-xs text-[color:var(--color-fg-muted)]">{d.synopsis}</p>
              ) : (
                /* Diff framing: BEFORE = what THIS peer/secondary currently
                   has; AFTER = what the anchor/primary has (the target).
                   So records to *remove* (lines only on this peer/secondary)
                   go on the left (red), and records to *add* (lines only
                   on the anchor/primary) go on the right (green). */
                <BareDiff removed={d.onlyOnSecondary} added={d.onlyOnPrimary} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Badge({ text, tone }: { text: string; tone: "success" | "warn" | "error" }) {
  const tint =
    tone === "success"
      ? "bg-[color-mix(in_oklch,var(--color-success)_20%,transparent)] text-[color:var(--color-success)]"
      : tone === "warn"
        ? "bg-[color-mix(in_oklch,var(--color-warn)_20%,transparent)] text-[color:var(--color-warn)]"
        : "bg-[color-mix(in_oklch,var(--color-error)_20%,transparent)] text-[color:var(--color-error)]";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[0.625rem] uppercase ${tint}`}>
      {text}
    </span>
  );
}
