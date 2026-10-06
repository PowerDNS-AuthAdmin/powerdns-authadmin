import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOA_REFRESH_SECONDS,
  classifyMirrorSerial,
  isSettledSyncState,
  servedSerial,
  servedSerialOfZone,
  soaEditRolloverGraceMs,
  soaRefreshSeconds,
  withinSoaEditRolloverGrace,
} from "./serial-sync";

const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
// The most recent epoch-week boundary at or before 2026-10-10.
const BOUNDARY = Math.floor(Date.UTC(2026, 9, 10) / WEEK_MS) * WEEK_MS;
const MID_WEEK = BOUNDARY + 3 * 86_400_000;

describe("servedSerial", () => {
  it("prefers the post-SOA-EDIT serial", () => {
    expect(servedSerial({ serial: 2026100407, editedSerial: 2026103368 })).toBe(2026103368);
    expect(servedSerialOfZone({ serial: 2026100407, edited_serial: 2026103368 })).toBe(2026103368);
  });

  it("falls back to the raw serial", () => {
    expect(servedSerial({ serial: 7, editedSerial: null })).toBe(7);
    expect(servedSerialOfZone({ serial: 7 })).toBe(7);
    expect(servedSerialOfZone({})).toBeNull();
  });
});

describe("classifyMirrorSerial", () => {
  it("SOA-EDIT zone: mirror holding the served serial is in-sync (#146)", () => {
    const primary = { serial: 2026100407, editedSerial: 2026103368 };
    expect(classifyMirrorSerial(primary, { serial: 2026103368 }, { now: MID_WEEK })).toBe(
      "in-sync",
    );
  });

  it("no SOA-EDIT: raw == edited, equal serials are in-sync", () => {
    expect(
      classifyMirrorSerial({ serial: 10, editedSerial: 10 }, { serial: 10 }, { now: MID_WEEK }),
    ).toBe("in-sync");
  });

  it("a mirror on the RAW serial of an SOA-EDIT zone is lagging, not in-sync", () => {
    const primary = { serial: 2026100407, editedSerial: 2026103368 };
    expect(classifyMirrorSerial(primary, { serial: 2026100407 }, { now: MID_WEEK })).toBe(
      "lagging",
    );
  });

  it("no SOA-EDIT: behind is lagging even right after the weekly boundary", () => {
    expect(
      classifyMirrorSerial({ serial: 11, editedSerial: 11 }, { serial: 10 }, { now: BOUNDARY }),
    ).toBe("lagging");
  });

  it("SOA-EDIT: behind within one refresh of the weekly rollover is refresh-due", () => {
    const primary = { serial: 100, editedSerial: 3000 };
    expect(classifyMirrorSerial(primary, { serial: 2999 }, { now: BOUNDARY + HOUR_MS })).toBe(
      "refresh-due",
    );
  });

  it("SOA-EDIT: behind past the grace window is lagging", () => {
    const primary = { serial: 100, editedSerial: 3000 };
    expect(classifyMirrorSerial(primary, { serial: 2999 }, { now: MID_WEEK })).toBe("lagging");
    expect(classifyMirrorSerial(primary, { serial: 2999 }, { now: BOUNDARY + 4 * HOUR_MS })).toBe(
      "lagging",
    );
  });

  it("grace follows the zone's SOA refresh when known", () => {
    const primary = { serial: 100, editedSerial: 3000 };
    const at = BOUNDARY + 20 * HOUR_MS;
    expect(classifyMirrorSerial(primary, { serial: 2999 }, { now: at })).toBe("lagging");
    expect(
      classifyMirrorSerial(primary, { serial: 2999 }, { now: at, refreshSeconds: 86_400 }),
    ).toBe("refresh-due");
  });

  it("mirror above the served serial is ahead", () => {
    expect(
      classifyMirrorSerial({ serial: 100, editedSerial: 3000 }, { serial: 3001 }, { now: 0 }),
    ).toBe("ahead");
  });

  it("missing zone and unknown serials", () => {
    expect(classifyMirrorSerial({ serial: 1, editedSerial: 1 }, null)).toBe("missing");
    expect(classifyMirrorSerial({ serial: null, editedSerial: null }, { serial: 1 })).toBe("error");
    expect(classifyMirrorSerial({ serial: 1, editedSerial: 1 }, { serial: null })).toBe("error");
  });
});

describe("isSettledSyncState", () => {
  it("only in-sync and refresh-due are settled", () => {
    expect(isSettledSyncState("in-sync")).toBe(true);
    expect(isSettledSyncState("refresh-due")).toBe(true);
    for (const s of ["ahead", "lagging", "missing", "error"] as const) {
      expect(isSettledSyncState(s)).toBe(false);
    }
  });
});

describe("SOA-EDIT rollover window", () => {
  it("weekly boundaries fall on Thursday 00:00 UTC", () => {
    const d = new Date(BOUNDARY);
    expect(d.getUTCDay()).toBe(4);
    expect(d.getUTCHours()).toBe(0);
  });

  it("grace is one refresh plus margin, capped at a week", () => {
    expect(soaEditRolloverGraceMs()).toBe(DEFAULT_SOA_REFRESH_SECONDS * 1000 + 5 * 60_000);
    expect(soaEditRolloverGraceMs(60)).toBe(60_000 + 5 * 60_000);
    expect(soaEditRolloverGraceMs(30 * 86_400)).toBe(WEEK_MS);
  });

  it("window opens at the boundary and closes after the grace", () => {
    expect(withinSoaEditRolloverGrace(BOUNDARY)).toBe(true);
    expect(withinSoaEditRolloverGrace(BOUNDARY - 1)).toBe(false);
    expect(withinSoaEditRolloverGrace(BOUNDARY + soaEditRolloverGraceMs() - 1)).toBe(true);
    expect(withinSoaEditRolloverGrace(BOUNDARY + soaEditRolloverGraceMs())).toBe(false);
  });
});

describe("soaRefreshSeconds", () => {
  const soa = (content: string) => [{ name: "example.com.", type: "SOA", records: [{ content }] }];

  it("reads the refresh field", () => {
    expect(
      soaRefreshSeconds(
        "example.com.",
        soa("ns1.example.com. hostmaster.example.com. 2026100701 7200 900 1209600 300"),
      ),
    ).toBe(7200);
  });

  it("null when absent or malformed", () => {
    expect(soaRefreshSeconds("example.com.", [])).toBeNull();
    expect(soaRefreshSeconds("example.com.", soa("garbage"))).toBeNull();
    expect(soaRefreshSeconds("other.example.", soa("a. b. 1 7200 900 1209600 300"))).toBeNull();
  });
});
