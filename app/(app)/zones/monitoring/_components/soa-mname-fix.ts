/**
 * app/(app)/zones/monitoring/_components/soa-mname-fix.ts
 *
 * The two requests behind a suggested SOA MNAME fix, shared by the one-zone
 * dialog and the bulk one: read the zone's live SOA and work out the new one,
 * then save it through the record editor's own write route
 * (`PATCH /api/admin/pdns/zones/<zone>/rrsets`), so the `soa.update`
 * permission check, validation, audit row and NOTIFY are the ones a manual
 * SOA edit gets.
 *
 * The SOA is read at review time rather than taken from the finding: the
 * finding is from the last probe and may be minutes old, and the review must
 * show what will actually be replaced.
 */

import { withSoaMname } from "@/components/domain/zone-monitor-format";
import { mutate } from "@/lib/client/api-fetch";

const HTTP_FORBIDDEN = 403;

export interface SoaRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}

export type SoaPlan =
  | { state: "ready"; before: SoaRRset; after: SoaRRset }
  /** The live SOA already names the suggested primary: fixed since the last check. */
  | { state: "unchanged"; before: SoaRRset }
  | { state: "error"; message: string; forbidden: boolean };

export async function planSoaMnameFix(
  zone: string,
  serverSlug: string,
  suggested: string,
): Promise<SoaPlan> {
  const query = new URLSearchParams({ serverSlug, name: "@", type: "SOA" });
  const result = await mutate<{ rrsets: SoaRRset[] }>(
    `/api/admin/pdns/zones/${encodeURIComponent(zone)}/records?${query.toString()}`,
  );
  if (!result.ok) {
    const forbidden = result.status === HTTP_FORBIDDEN;
    return {
      state: "error",
      forbidden,
      message: forbidden ? "You don't have permission to read this zone's SOA." : result.error,
    };
  }
  const before = result.data.rrsets.find((rr) => rr.type === "SOA");
  const record = before?.records[0];
  if (!before || !record) {
    return { state: "error", forbidden: false, message: "The zone has no SOA record to change." };
  }
  const content = withSoaMname(record.content, suggested);
  if (content === record.content) return { state: "unchanged", before };
  return { state: "ready", before, after: { ...before, records: [{ ...record, content }] } };
}

export type SoaSaveResult =
  | { ok: true; notified: boolean; notifyError: string | null }
  | { ok: false; forbidden: boolean; error: string };

export async function saveSoa(
  zone: string,
  serverSlug: string,
  after: SoaRRset,
): Promise<SoaSaveResult> {
  const result = await mutate<{ notified?: boolean; notifyError?: string } | null>(
    `/api/admin/pdns/zones/${encodeURIComponent(zone)}/rrsets`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverSlug,
        changes: [
          {
            kind: "upsert" as const,
            name: after.name,
            type: "SOA",
            ttl: after.ttl,
            records: after.records.map((r) => ({
              content: r.content,
              disabled: r.disabled ?? false,
            })),
          },
        ],
      }),
    },
  );
  if (!result.ok) {
    const forbidden = result.status === HTTP_FORBIDDEN;
    return {
      ok: false,
      forbidden,
      error: forbidden ? "You don't have permission to change this zone's SOA." : result.error,
    };
  }
  return {
    ok: true,
    notified: result.data?.notified ?? false,
    notifyError: result.data?.notifyError ?? null,
  };
}
