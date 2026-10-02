import { describe, expect, it } from "vitest";
import { ZONE_DEFAULT_TTL_KIND } from "@/lib/dns/default-ttl";
import { createZoneTemplateSchema } from "./zone-templates";

const base = { slug: "web", name: "Web" };

describe("createZoneTemplateSchema metadata", () => {
  it("accepts a valid per-zone default TTL", () => {
    const parsed = createZoneTemplateSchema.parse({
      ...base,
      metadata: { [ZONE_DEFAULT_TTL_KIND]: ["300"] },
    });
    expect(parsed.metadata[ZONE_DEFAULT_TTL_KIND]).toEqual(["300"]);
  });

  it("rejects an invalid per-zone default TTL, since zone creation copies it verbatim", () => {
    const result = createZoneTemplateSchema.safeParse({
      ...base,
      metadata: { [ZONE_DEFAULT_TTL_KIND]: ["five minutes"] },
    });
    expect(result.success).toBe(false);
  });
});
