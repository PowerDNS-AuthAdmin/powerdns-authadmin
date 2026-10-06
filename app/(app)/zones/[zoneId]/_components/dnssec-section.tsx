/**
 * DNSSEC tab body - rendered from the main zone page when `?tab=dnssec`.
 * Originally lived at `/zones/[id]/dnssec/page.tsx`; collapsed in so
 * every tab is a query-string switch (instant, no route navigation,
 * no loading-shimmer flash).
 */

import { recentDnssecAuditForZone } from "@/lib/db/repositories/audit-log";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { freshnessOf } from "@/lib/freshness";
import {
  dsRecordsToPublish,
  isTransferredKind,
  planDnssecEnable,
  signedZoneWarnings,
} from "@/lib/pdns/dnssec-plan";
import { zoneHasMirrors } from "@/lib/pdns/sync";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsCryptokeySummary, PdnsZoneDetail } from "@/lib/pdns/types";
import { CryptokeyActions } from "../dnssec/_components/cryptokey-actions";
import { DnssecZoneActions } from "../dnssec/_components/dnssec-zone-actions";

interface Props {
  zoneIdEncoded: string;
  zone: PdnsZoneDetail;
  selected: PdnsServer;
  // Per-zone authorization decided by the parent page (global permission OR
  // a zone_grant for this server+zone) - see app/(app)/zones/[zoneId]/page.tsx.
  canRead: boolean;
  canConfigure: boolean;
}

export async function DnssecSection({
  zoneIdEncoded,
  zone,
  selected,
  canRead,
  canConfigure,
}: Props) {
  const zoneName = zone.name;
  if (!canRead) {
    return (
      <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm">
        You don&apos;t have permission to view DNSSEC keys for this zone.
      </div>
    );
  }

  let keys: PdnsCryptokeySummary[] | null = null;
  let fetchError: string | null = null;
  try {
    const client = getBackendGateway(selected);
    keys = await client.listCryptokeys(zoneName);
  } catch (err) {
    if (err instanceof PdnsNotFoundError) {
      return (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          Zone not found on backend.
        </div>
      );
    }
    fetchError = err instanceof Error ? redact(err.message) : "Unknown error";
    logger.warn(
      { server: selected.slug, zone: zoneName, err: fetchError },
      "zone.dnssec.list.failed",
    );
  }

  const lastActivityByKey = new Map<number, Date>();
  if (keys && keys.length > 0) {
    const auditRows = await recentDnssecAuditForZone(selected.slug, zoneName, 200);
    for (const row of auditRows) {
      const id = extractCryptokeyId(row.before, row.after);
      if (id !== null && !lastActivityByKey.has(id)) {
        lastActivityByKey.set(id, row.ts);
      }
    }
  }

  const signed = zone.dnssec === true;
  const replicated = isTransferredKind(zone.kind) || (await zoneHasMirrors(selected, zoneName));
  const warnings = signed
    ? signedZoneWarnings(zone, replicated)
    : planDnssecEnable(zone, replicated).warnings;
  const ds = dsRecordsToPublish(keys ?? []);

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">
              DNSSEC is{" "}
              <span
                className={
                  signed
                    ? "text-[color:var(--color-success)]"
                    : "text-[color:var(--color-fg-muted)]"
                }
              >
                {signed ? "enabled" : "off"}
              </span>
            </h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
              <dt className="text-[color:var(--color-fg-muted)]">Denial of existence</dt>
              <dd className="font-mono">{zone.nsec3param ? `NSEC3 ${zone.nsec3param}` : "NSEC"}</dd>
              <dt className="text-[color:var(--color-fg-muted)]">SOA-EDIT</dt>
              <dd className="font-mono">
                {zone.soa_edit === undefined || zone.soa_edit === "" ? "(unset)" : zone.soa_edit}
              </dd>
              <dt className="text-[color:var(--color-fg-muted)]">API-RECTIFY</dt>
              <dd className="font-mono">
                {zone.api_rectify === undefined ? "-" : String(zone.api_rectify)}
              </dd>
            </dl>
          </div>
          {canConfigure ? (
            <DnssecZoneActions
              zoneIdEncoded={zoneIdEncoded}
              zoneName={zoneName}
              serverSlug={selected.slug}
              signed={signed}
              replicated={replicated}
              soaEdit={zone.soa_edit ?? ""}
            />
          ) : null}
        </header>
        {warnings.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-[color:var(--color-warn)]">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {signed && ds.length > 0 ? (
          <KeyField label="DS to publish at the registrar (SHA-256 is digest type 2)">
            <ul className="space-y-1">
              {ds.map((rec) => (
                <li key={rec}>
                  <code className="break-all">{rec}</code>
                </li>
              ))}
            </ul>
          </KeyField>
        ) : null}
      </section>

      <h2 className="text-lg font-semibold">
        DNSSEC keys{" "}
        <span className="text-sm font-normal text-[color:var(--color-fg-muted)]">
          - DS records below go to your domain registrar to enable DNSSEC validation upstream.
        </span>
      </h2>

      {fetchError ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          <strong>Could not list cryptokeys.</strong>
          <p className="mt-1 text-xs">{fetchError}</p>
        </div>
      ) : null}

      {canConfigure ? (
        <CryptokeyActions
          zoneIdEncoded={zoneIdEncoded}
          serverSlug={selected.slug}
          rows={(keys ?? []).map((k) => ({
            id: k.id,
            keytype: k.keytype,
            active: k.active,
            ...(k.published !== undefined ? { published: k.published } : {}),
          }))}
        />
      ) : null}

      {keys?.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5 text-sm">
          This zone has no DNSSEC keys configured. The zone is unsigned. Use Enable DNSSEC above -
          generating keys one by one here doesn&apos;t rectify the zone.
        </div>
      ) : null}

      {keys && keys.length > 0 ? <DnssecSummary keys={keys} /> : null}

      {keys && keys.length > 0 ? (
        <ul className="space-y-4">
          {keys.map((k) => (
            <li
              key={k.id}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5"
            >
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="rounded bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-xs uppercase">
                  {k.keytype}
                </span>
                <span
                  className={
                    k.active
                      ? "text-xs text-[color:var(--color-success)]"
                      : "text-xs text-[color:var(--color-fg-muted)]"
                  }
                >
                  {k.active ? "active" : "inactive"}
                </span>
                {k.published === false ? (
                  <span className="text-xs text-[color:var(--color-fg-muted)]">not published</span>
                ) : null}
                {k.algorithm ? (
                  <span className="text-xs text-[color:var(--color-fg-muted)]">
                    {k.algorithm}
                    {k.bits ? ` · ${k.bits} bits` : ""}
                  </span>
                ) : null}
                <span className="text-xs text-[color:var(--color-fg-muted)]">id {k.id}</span>
                {lastActivityByKey.has(k.id) ? (
                  <span
                    className="text-xs text-[color:var(--color-fg-muted)]"
                    title={lastActivityByKey.get(k.id)!.toISOString()}
                  >
                    · last activity {freshnessOf(lastActivityByKey.get(k.id)!.toISOString()).label}
                  </span>
                ) : null}
              </header>

              <KeyField label="DNSKEY">
                <code className="break-all">{k.dnskey}</code>
              </KeyField>

              {k.ds && k.ds.length > 0 ? (
                <KeyField label="DS records (give these to your registrar)">
                  <ul className="space-y-1">
                    {k.ds.map((rec, i) => (
                      <li key={i}>
                        <code className="break-all">{rec}</code>
                      </li>
                    ))}
                  </ul>
                </KeyField>
              ) : null}

              {k.cds && k.cds.length > 0 ? (
                <KeyField label="CDS records (auto-published in the zone)">
                  <ul className="space-y-1">
                    {k.cds.map((rec, i) => (
                      <li key={i}>
                        <code className="break-all">{rec}</code>
                      </li>
                    ))}
                  </ul>
                </KeyField>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function KeyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </div>
      <div className="mt-1 rounded bg-[color:var(--color-bg-subtle)] p-3 font-mono text-xs">
        {children}
      </div>
    </div>
  );
}

function extractCryptokeyId(before: unknown, after: unknown): number | null {
  return pickKeyId(before) ?? pickKeyId(after);
}

function pickKeyId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)["cryptokeyId"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function DnssecSummary({
  keys,
}: {
  keys: ReadonlyArray<{
    keytype: string;
    active: boolean;
    published?: boolean;
    algorithm?: string;
  }>;
}) {
  const byType = new Map<string, number>();
  for (const k of keys) byType.set(k.keytype, (byType.get(k.keytype) ?? 0) + 1);
  const activeCount = keys.filter((k) => k.active).length;
  const unpublishedCount = keys.filter((k) => k.published === false).length;
  const algorithms = Array.from(
    new Set(keys.map((k) => k.algorithm).filter((a): a is string => Boolean(a))),
  ).sort();
  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
      <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        Key summary
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <SummaryStat label="Total keys" value={String(keys.length)} />
        <SummaryStat
          label="Active"
          value={`${activeCount} / ${keys.length}`}
          tone={activeCount === 0 ? "warn" : undefined}
        />
        {Array.from(byType.entries()).map(([type, count]) => (
          <SummaryStat key={type} label={type.toUpperCase()} value={String(count)} />
        ))}
        {unpublishedCount > 0 ? (
          <SummaryStat label="Not published" value={String(unpublishedCount)} tone="warn" />
        ) : null}
      </dl>
      {algorithms.length > 0 ? (
        <p className="mt-3 text-xs text-[color:var(--color-fg-muted)]">
          Algorithms in use:{" "}
          {algorithms.map((a, i) => (
            <span key={a}>
              <code className="rounded bg-[color:var(--color-bg)] px-1">{a}</code>
              {i < algorithms.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="contents">
      <dt className="text-[color:var(--color-fg-muted)]">{label}</dt>
      <dd
        className={
          tone === "warn"
            ? "font-mono font-medium text-[color:var(--color-warn)]"
            : "font-mono font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}
