import { describe, expect, it } from "vitest";
import {
  buildUpsertChange,
  canonicalizeRecordName,
  describeExistingValues,
  describeRecordChange,
  displayRecordName,
  parseWizardPrefill,
  recordsPageHref,
  syncMemberAppearance,
  wizardStartStep,
  type ExistingRRset,
  type RecordDraftInput,
} from "./record-wizard-format";

const ZONE = "example.com.";

const draft = (overrides: Partial<RecordDraftInput> = {}): RecordDraftInput => ({
  zoneName: ZONE,
  name: "www",
  type: "A",
  ttl: 3600,
  content: "192.0.2.10",
  disabled: false,
  comment: "",
  ptr: false,
  existing: null,
  ...overrides,
});

const existingWww: ExistingRRset = {
  name: "www.example.com.",
  type: "A",
  ttl: 300,
  records: [{ content: "192.0.2.1" }, { content: "192.0.2.2", disabled: true }],
  comment: "web tier",
};

describe("canonicalizeRecordName / displayRecordName", () => {
  it("treats @ and an empty label as the apex", () => {
    expect(canonicalizeRecordName("@", ZONE)).toBe(ZONE);
    expect(canonicalizeRecordName("  ", ZONE)).toBe(ZONE);
    expect(displayRecordName(ZONE, ZONE)).toBe("@");
  });

  it("qualifies relative labels and lowercases them", () => {
    expect(canonicalizeRecordName("WWW", ZONE)).toBe("www.example.com.");
    expect(displayRecordName("www.example.com.", ZONE)).toBe("www");
  });

  it("leaves an already fully-qualified name alone", () => {
    expect(canonicalizeRecordName("mail.other.net.", ZONE)).toBe("mail.other.net.");
    expect(displayRecordName("mail.other.net.", ZONE)).toBe("mail.other.net.");
  });
});

describe("wizardStartStep", () => {
  it("asks for the horizon only when both horizons hold zones", () => {
    expect(wizardStartStep({ public: 3, internal: 2 }, false)).toEqual({
      step: "horizon",
      horizon: null,
    });
  });

  it("defaults to the only horizon that has zones", () => {
    expect(wizardStartStep({ public: 0, internal: 2 }, false)).toEqual({
      step: "zone",
      horizon: "internal",
    });
    expect(wizardStartStep({ public: 5, internal: 0 }, false)).toEqual({
      step: "zone",
      horizon: "public",
    });
    expect(wizardStartStep({ public: 0, internal: 0 }, false)).toEqual({
      step: "zone",
      horizon: "public",
    });
  });

  it("skips the question when the zone came from the URL", () => {
    expect(wizardStartStep({ public: 3, internal: 2 }, true)).toEqual({
      step: "zone",
      horizon: null,
    });
  });
});

describe("buildUpsertChange", () => {
  it("creates a one-record RRset and omits comment and ptr when unset", () => {
    const { change, mode } = buildUpsertChange(draft());
    expect(mode).toBe("create");
    expect(change).toEqual({
      kind: "upsert",
      name: "www.example.com.",
      type: "A",
      ttl: 3600,
      records: [{ content: "192.0.2.10" }],
    });
    expect("ptr" in change).toBe(false);
    expect("comment" in change).toBe(false);
  });

  it("appends to the existing records, keeping their disabled flags", () => {
    const { change, mode } = buildUpsertChange(draft({ existing: existingWww, ttl: 300 }));
    expect(mode).toBe("append");
    expect(change.records).toEqual([
      { content: "192.0.2.1" },
      { content: "192.0.2.2", disabled: true },
      { content: "192.0.2.10" },
    ]);
    expect(change.ttl).toBe(300);
  });

  it("sends ptr only for an address type with the box ticked", () => {
    expect(buildUpsertChange(draft({ ptr: true })).change.ptr).toBe(true);
    expect("ptr" in buildUpsertChange(draft({ ptr: false })).change).toBe(false);
    expect(
      "ptr" in buildUpsertChange(draft({ ptr: true, type: "TXT", content: '"v=spf1"' })).change,
    ).toBe(false);
  });

  it("marks a disabled value, trims content and the comment, uppercases the type", () => {
    const { change } = buildUpsertChange(
      draft({ type: "aaaa", content: " 2001:db8::1 ", disabled: true, comment: "  note " }),
    );
    expect(change.type).toBe("AAAA");
    expect(change.records).toEqual([{ content: "2001:db8::1", disabled: true }]);
    expect(change.comment).toBe("note");
  });
});

describe("describeRecordChange", () => {
  it("says it adds a value when the RRset exists", () => {
    const { change, mode } = buildUpsertChange(draft({ existing: existingWww, ttl: 300 }));
    expect(describeRecordChange(mode, change, ZONE)).toBe(
      'Adds the value "192.0.2.10" to the existing A RRset at www.example.com. (3 values after save).',
    );
  });

  it("names the apex explicitly", () => {
    const { change, mode } = buildUpsertChange(draft({ name: "@", type: "TXT", content: "x" }));
    expect(describeRecordChange(mode, change, ZONE)).toBe(
      'Creates a TXT record at the apex of example.com. with the value "x" (TTL 3600).',
    );
  });
});

describe("describeExistingValues", () => {
  it("lists every value with its TTL, flags disabled ones, appends the comment", () => {
    expect(describeExistingValues(existingWww)).toBe(
      "192.0.2.1  TTL 300\n(disabled) 192.0.2.2  TTL 300\nComment: web tier",
    );
  });
});

describe("recordsPageHref", () => {
  it("encodes the zone and the backend slug", () => {
    expect(recordsPageHref("0/26.2.0.192.in-addr.arpa.", "ns 1")).toBe(
      "/zones/0%2F26.2.0.192.in-addr.arpa.?server=ns%201",
    );
  });
});

describe("syncMemberAppearance", () => {
  it("treats in-sync and refresh-due as settled", () => {
    expect(syncMemberAppearance("in-sync").settled).toBe(true);
    expect(syncMemberAppearance("refresh-due")).toMatchObject({ settled: true, tone: "success" });
  });

  it("colours a catch-up orange and a missing copy red", () => {
    expect(syncMemberAppearance("lagging")).toMatchObject({ tone: "warn", settled: false });
    expect(syncMemberAppearance("unknown")).toMatchObject({ tone: "warn", label: "waiting" });
    expect(syncMemberAppearance("missing")).toMatchObject({ tone: "error", label: "missing" });
    expect(syncMemberAppearance("error")).toMatchObject({ tone: "error" });
  });
});

describe("parseWizardPrefill", () => {
  it("canonicalizes the zone, uppercases a valid type and drops an invalid one", () => {
    expect(
      parseWizardPrefill({
        zone: "Example.COM",
        server: "ns1",
        name: "www",
        type: "aaaa",
        content: "2001:db8::1",
      }),
    ).toEqual({
      zone: "example.com.",
      server: "ns1",
      name: "www",
      type: "AAAA",
      content: "2001:db8::1",
    });
    expect(parseWizardPrefill({ type: "not a type" }).type).toBeNull();
  });

  it("yields nulls and empty strings when nothing was passed", () => {
    expect(parseWizardPrefill({})).toEqual({
      zone: null,
      server: null,
      name: "",
      type: null,
      content: "",
    });
  });
});
