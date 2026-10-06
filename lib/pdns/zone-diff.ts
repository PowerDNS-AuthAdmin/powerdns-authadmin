/**
 * lib/pdns/zone-diff.ts
 *
 * Record-level comparison of two copies of a zone, as returned by the PDNS
 * API on each server. Pure, so the normalisation rules are unit-testable.
 *
 * Two things differ between a signed primary and its presigned mirror even
 * when both serve byte-identical answers (issue #146):
 *
 *   - The SOA serial. The primary's API returns the raw stored serial; the
 *     mirror stored the post-SOA-EDIT serial it was sent. The serial is
 *     compared on its own (lib/pdns/serial-sync.ts), so the SOA line is
 *     compared with the serial masked.
 *   - DNSSEC records. A primary signs on the fly and its API lists no
 *     RRSIG/DNSKEY/NSEC*; a presigned mirror stores them as ordinary records.
 *     For a signed primary those types are left out of the diff and counted
 *     instead.
 */

import { canonicalTxtContent } from "@/lib/dns/txt";

/** Types the signer generates - never in a signed primary's API view. */
export const DNSSEC_GENERATED_TYPES: ReadonlySet<string> = new Set([
  "RRSIG",
  "NSEC",
  "NSEC3",
  "NSEC3PARAM",
  "DNSKEY",
  "CDS",
  "CDNSKEY",
]);

export interface DiffRRset {
  name: string;
  type: string;
  ttl: number;
  records: ReadonlyArray<{ content: string; disabled?: boolean }>;
}

export interface ZoneDiffOptions {
  /** The anchor (primary) zone is DNSSEC-signed: ignore signer-generated types. */
  signed?: boolean;
}

export interface ZoneDiff {
  /** Lines present on the anchor but not the other side. */
  onlyOnPrimary: string[];
  /** Lines present on the other side but not the anchor. */
  onlyOnSecondary: string[];
  /** Signer-generated records the other side stores that were not compared. */
  presignedRecords: number;
}

export function diffZoneRecords(
  primary: readonly DiffRRset[],
  secondary: readonly DiffRRset[],
  opts: ZoneDiffOptions = {},
): ZoneDiff {
  const skip = opts.signed ? DNSSEC_GENERATED_TYPES : null;
  const primaryLines = rrsetsToCanonicalLines(primary, skip).lines;
  const { lines: secondaryLines, skipped } = rrsetsToCanonicalLines(secondary, skip);
  const primarySet = new Set(primaryLines);
  const secondarySet = new Set(secondaryLines);
  return {
    onlyOnPrimary: primaryLines.filter((l) => !secondarySet.has(l)),
    onlyOnSecondary: secondaryLines.filter((l) => !primarySet.has(l)),
    presignedRecords: skipped,
  };
}

export function rrsetsToCanonicalLines(
  rrsets: readonly DiffRRset[],
  skipTypes: ReadonlySet<string> | null = null,
): { lines: string[]; skipped: number } {
  const lines: string[] = [];
  let skipped = 0;
  for (const rr of rrsets) {
    const type = rr.type.toUpperCase();
    if (skipTypes?.has(type)) {
      skipped += rr.records.length;
      continue;
    }
    for (const r of rr.records) {
      const prefix = r.disabled ? "; DISABLED " : "";
      const content = canonicalContentForCompare(type, r.content);
      lines.push(`${prefix}${rr.name}\t${rr.ttl}\tIN\t${rr.type}\t${content}`);
    }
  }
  return { lines: lines.sort(), skipped };
}

/**
 * Normalize a record's content so cross-peer comparison is by *meaning*,
 * not presentation. TXT/SPF: the same value can arrive as one long quoted
 * string from one peer and as several adjacent 255-octet character-strings
 * from another (PDNS re-chunks on AXFR); concatenating the character-strings
 * collapses both forms to the same key. SOA: the serial is masked (see the
 * module header). Every other type already has a single canonical
 * presentation from PDNS.
 */
export function canonicalContentForCompare(type: string, content: string): string {
  const t = type.toUpperCase();
  if (t === "TXT" || t === "SPF") return canonicalTxtContent(content);
  if (t === "SOA") return maskSoaSerial(content);
  return content;
}

/** Replace the serial field of SOA content with a placeholder. */
export function maskSoaSerial(content: string): string {
  const fields = content.trim().split(/\s+/);
  if (fields.length !== 7) return content;
  fields[2] = "<serial>";
  return fields.join(" ");
}
