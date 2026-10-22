import { describe, expect, it } from "vitest";
import {
  groupMappingsSchema,
  prepareGroupMappings,
  unknownZoneTargets,
  type GroupMappingRow,
} from "./group-mappings";

const row = (over: Partial<GroupMappingRow> = {}): GroupMappingRow => ({
  group: "dns-admins",
  roleSlug: "zone-editor",
  scopeType: "global",
  scopeId: null,
  ...over,
});

describe("prepareGroupMappings", () => {
  it("keeps complete rows, trimmed", () => {
    const { mappings, problems } = prepareGroupMappings([
      row({ group: "  dns-admins ", scopeType: "team", scopeId: " noc " }),
    ]);
    expect(problems).toEqual([]);
    expect(mappings).toEqual([row({ scopeType: "team", scopeId: "noc" })]);
  });

  it("drops a row left completely empty", () => {
    const { mappings, problems } = prepareGroupMappings([row({ group: "" }), row()]);
    expect(problems).toEqual([]);
    expect(mappings).toHaveLength(1);
  });

  it("reports a partly filled row instead of dropping it", () => {
    const { mappings, problems } = prepareGroupMappings([
      row(),
      row({ scopeType: "zone", scopeId: "" }),
      row({ group: "", scopeType: "team", scopeId: "noc" }),
    ]);
    expect(mappings).toHaveLength(1);
    expect(problems).toEqual(["Mapping 2 needs a target zone.", "Mapping 3 needs an IdP group."]);
  });

  it("canonicalises zone targets and rejects non-names", () => {
    const { mappings, problems } = prepareGroupMappings([
      row({ scopeType: "zone", scopeId: " Example.COM " }),
      row({ scopeType: "zone", scopeId: "not a zone" }),
    ]);
    expect(mappings[0]?.scopeId).toBe("example.com.");
    expect(problems).toEqual(['Mapping 2: "not a zone" is not a zone name.']);
  });
});

describe("groupMappingsSchema", () => {
  const schema = groupMappingsSchema(500);

  it("stores zone targets canonically", () => {
    const parsed = schema.parse([row({ scopeType: "zone", scopeId: "Example.com" })]);
    expect(parsed?.[0]?.scopeId).toBe("example.com.");
  });

  it("rejects a zone target that is not a zone name", () => {
    expect(schema.safeParse([row({ scopeType: "zone", scopeId: "a b" })]).success).toBe(false);
  });

  it("still requires a target for team, zone and server scopes", () => {
    expect(schema.safeParse([row({ scopeType: "team", scopeId: null })]).success).toBe(false);
    expect(schema.safeParse([row({ scopeId: "x" })]).success).toBe(false);
  });
});

describe("unknownZoneTargets", () => {
  const mappings = [
    row({ scopeType: "zone", scopeId: "example.com." }),
    row({ scopeType: "zone", scopeId: "exmaple.com." }),
    row({ scopeType: "team", scopeId: "noc" }),
  ];

  it("names zone targets no backend serves", () => {
    expect(unknownZoneTargets(mappings, new Set(["example.com."]))).toEqual(["exmaple.com."]);
  });

  it("reports nothing while the zone set is not fully known", () => {
    expect(unknownZoneTargets(mappings, null)).toEqual([]);
  });
});
