/**
 * lib/pdns/dnssec-actions.ts
 *
 * The PDNS-side follow-ups the zone-level DNSSEC routes share: making sure
 * the served serial moved (so secondaries re-transfer the newly signed or
 * unsigned zone) and sending the NOTIFY. Decisions live in
 * lib/pdns/dnssec-plan.ts; this module only does the I/O.
 */

import "server-only";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { bumpSoaSerial, isTransferredKind } from "@/lib/pdns/dnssec-plan";
import { servedSerialOfZone } from "@/lib/pdns/serial-sync";
import type { PdnsClient } from "@/lib/pdns/client";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

/**
 * How the served serial was advanced:
 *   - "pdns"      PowerDNS changed it itself (SOA-EDIT-API on the zone PUT,
 *                 or a newly set SOA-EDIT).
 *   - "patched"   We bumped the SOA serial (no SOA-EDIT-API on the zone, or
 *                 an operation that never bumps, like rectify).
 *   - "unchanged" Nothing to do / couldn't (no SOA rrset).
 */
export type SerialAdvance = "pdns" | "patched" | "unchanged";

/**
 * Ensure the zone's served serial is above `servedBefore`; bump the SOA serial
 * by one when it isn't. Returns the re-read zone alongside how it advanced.
 */
export async function ensureServedSerialAdvanced(
  client: PdnsClient,
  zoneName: string,
  servedBefore: number | null,
): Promise<{ zone: PdnsZoneDetail; advance: SerialAdvance }> {
  const zone = await client.getZone(zoneName);
  const servedNow = servedSerialOfZone(zone);
  if (servedBefore !== null && servedNow !== null && servedNow !== servedBefore) {
    return { zone, advance: "pdns" };
  }
  const soa = (zone.rrsets ?? []).find((r) => r.type === "SOA" && r.name === zone.name);
  const content = soa?.records[0]?.content;
  const bumped = content ? bumpSoaSerial(content) : null;
  if (!soa || !bumped) return { zone, advance: "unchanged" };
  // No `comments` field: PDNS keeps the existing SOA comments when it's absent.
  await client.patchZone(zoneName, {
    rrsets: [
      {
        name: soa.name,
        type: "SOA",
        ttl: soa.ttl,
        changetype: "REPLACE",
        records: [{ content: bumped, disabled: false }],
      },
    ],
  });
  return { zone: await client.getZone(zoneName), advance: "patched" };
}

/**
 * NOTIFY the zone's secondaries if PowerDNS would transfer it. Best-effort:
 * a failure is logged and reported, never thrown - the DNSSEC change itself
 * already succeeded, and secondaries still catch up at their SOA refresh.
 */
export async function notifyIfTransferred(
  client: PdnsClient,
  zone: Pick<PdnsZoneDetail, "name" | "kind">,
  serverSlug: string,
): Promise<boolean> {
  if (!isTransferredKind(zone.kind)) return false;
  try {
    await client.notifyZone(zone.name);
    return true;
  } catch (err) {
    logger.warn(
      {
        server: serverSlug,
        zone: zone.name,
        err: err instanceof Error ? redact(err.message) : "unknown",
      },
      "pdns.dnssec.notify.failed",
    );
    return false;
  }
}
