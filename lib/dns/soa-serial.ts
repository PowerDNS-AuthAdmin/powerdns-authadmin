/**
 * Parse a SOA serial in the conventional `YYYYMMDDnn` layout (RFC 1912 § 2.2)
 * back into a Date. `nn` is a 00–99 same-day revision counter; we ignore it
 * for date purposes since it doesn't carry a clock.
 *
 * Returns null when the serial isn't in that format, or when the decoded
 * fields don't form a real calendar date - a serial that's just an epoch
 * counter or a monotonic integer will land here and the caller renders "-"
 * the same as if no audit row exists.
 *
 * Why this exists: the zone list's "Last edit" column reads from the local
 * audit log first. Zones edited via `pdnsutil` / direct backend pokes /
 * out-of-band edits won't have audit rows; when the operator followed the
 * YYYYMMDDnn convention, the SOA serial itself carries a usable last-edit
 * date. This helper is the fallback for that.
 */
export function parseSoaSerialDate(serial: number | null | undefined): Date | null {
  if (serial === null || serial === undefined) return null;
  if (!Number.isInteger(serial) || serial <= 0) return null;
  // 10 digits exactly: YYYY (4) + MM (2) + DD (2) + nn (2).
  // 1000000000 = year 0100; 9999999999 = year 9999. Anything outside
  // these bounds can't be YYYYMMDDnn - likely an epoch counter.
  if (serial < 1_000_000_000 || serial > 9_999_999_999) return null;

  const year = Math.floor(serial / 1_000_000);
  const month = Math.floor((serial / 10_000) % 100);
  const day = Math.floor((serial / 100) % 100);

  // Plausible-year guard: reject anything before the DNS era (the very
  // first .com zone was 1985) or unreasonably far ahead.
  const thisYear = new Date().getUTCFullYear();
  if (year < 1985 || year > thisYear + 1) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  // Treat the date as UTC midnight - operators bumping serials don't carry
  // a clock through this format and it's the convention most tools use.
  const d = new Date(Date.UTC(year, month - 1, day));

  // Verify the round-trip - `new Date(Date.UTC(2025, 1, 30))` happily
  // becomes March 2, 2025. We want strict calendar-valid dates only.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}
