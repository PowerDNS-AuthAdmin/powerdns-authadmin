/**
 * Metadata tab body — rendered from the main zone page when `?tab=metadata`.
 * Originally lived at `/zones/[id]/metadata/page.tsx`; collapsed in so
 * every tab is a query-string switch.
 */

import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsMetadata } from "@/lib/pdns/types";
import { AddMetadataKind } from "../metadata/_components/add-metadata-kind";
import { KIND_SPECS, ZONE_OBJECT_KINDS } from "../metadata/_components/kind-specs";
import { MetadataEditor } from "../metadata/_components/metadata-editor";

interface Props {
  zoneIdEncoded: string;
  zoneName: string;
  selected: PdnsServer;
  // Per-zone authorization decided by the parent page (global permission OR
  // a zone_grant for this server+zone) — see app/(app)/zones/[zoneId]/page.tsx.
  canRead: boolean;
  canWrite: boolean;
}

export async function MetadataSection({
  zoneIdEncoded,
  zoneName,
  selected,
  canRead,
  canWrite,
}: Props) {
  if (!canRead) {
    return (
      <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-4 text-sm">
        You don&apos;t have permission to view metadata for this zone.
      </div>
    );
  }

  let items: PdnsMetadata[] | null = null;
  let fetchError: string | null = null;
  try {
    const client = getPdnsClientForRow(selected);
    items = await client.listZoneMetadata(zoneName);
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
      "zone.metadata.list.failed",
    );
  }

  const sorted = items
    ? [...items]
        .filter((m) => !ZONE_OBJECT_KINDS.has(m.kind))
        .sort((a, b) => a.kind.localeCompare(b.kind))
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold">
          Zone metadata{" "}
          <span className="text-sm font-normal text-[color:var(--color-fg-muted)]">
            — per-zone configuration the PDNS daemon honors at lookup and transfer time.
          </span>
        </h2>
        {canWrite ? (
          <AddMetadataKind
            zoneIdEncoded={zoneIdEncoded}
            serverSlug={selected.slug}
            existingKinds={sorted?.map((m) => m.kind) ?? []}
          />
        ) : null}
      </div>

      {fetchError ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          <strong>Could not list metadata.</strong>
          <p className="mt-1 text-xs">{fetchError}</p>
        </div>
      ) : null}

      {sorted?.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5 text-sm">
          No metadata configured. The zone uses PDNS defaults for transfers, notifications, and
          signing.
        </div>
      ) : null}

      {sorted && sorted.length > 0 ? (
        <ul className="space-y-3">
          {sorted.map((m) => {
            const desc = KIND_SPECS[m.kind]?.description;
            return (
              <li
                key={m.kind}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5"
              >
                <header className="flex flex-wrap items-baseline gap-x-3">
                  <h3 className="font-mono text-sm font-medium">{m.kind}</h3>
                  <span className="text-xs text-[color:var(--color-fg-muted)]">
                    {m.metadata.length} value
                    {m.metadata.length === 1 ? "" : "s"}
                  </span>
                </header>
                {desc ? (
                  <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{desc}</p>
                ) : null}
                {m.metadata.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded bg-[color:var(--color-bg-subtle)] p-3 font-mono text-xs">
                    {m.metadata.map((v, i) => (
                      <li key={i}>
                        <code className="break-all">{v}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-[color:var(--color-fg-muted)] italic">
                    (kind set but empty)
                  </p>
                )}
                {canWrite ? (
                  <MetadataEditor
                    zoneIdEncoded={zoneIdEncoded}
                    serverSlug={selected.slug}
                    kind={m.kind}
                    initialValues={m.metadata}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
