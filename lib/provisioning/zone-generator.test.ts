import { describe, expect, it } from "vitest";
import { generateZones } from "./zone-generator";

describe("generateZones", () => {
  it("produces the requested count", () => {
    const z = generateZones({
      namePrefix: "demo",
      baseDomain: "example",
      count: 5,
      recordsPerZone: 10,
    });
    expect(z).toHaveLength(5);
    expect(z[0]!.name).toBe("demo-1.example.");
    expect(z[4]!.name).toBe("demo-5.example.");
  });

  it("appends a trailing dot to base_domain if missing", () => {
    const z = generateZones({
      namePrefix: "x",
      baseDomain: "internal",
      count: 1,
      recordsPerZone: 1,
    });
    expect(z[0]!.name).toBe("x-1.internal.");
  });

  it("respects a base_domain that already ends with a dot", () => {
    const z = generateZones({
      namePrefix: "x",
      baseDomain: "internal.",
      count: 1,
      recordsPerZone: 1,
    });
    expect(z[0]!.name).toBe("x-1.internal.");
  });

  it("groups same-(name,type) records into one rrset", () => {
    const z = generateZones({
      namePrefix: "g",
      baseDomain: "test",
      count: 1,
      recordsPerZone: 10,
    });
    const apex = z[0]!.rrsets.find((r) => r.name === "g-1.test." && r.type === "A");
    expect(apex).toBeDefined();
    expect(apex!.records!.length).toBe(2); // .1 and .2
  });

  it("pads with synthetic host records when recordsPerZone > template length", () => {
    const z = generateZones({
      namePrefix: "p",
      baseDomain: "t",
      count: 1,
      recordsPerZone: 15,
    });
    // Template has 10 entries; 5 extra = host03..host07
    const hostRr = z[0]!.rrsets.filter((r) => r.name.startsWith("host"));
    expect(hostRr.length).toBeGreaterThanOrEqual(7);
  });

  it("trims to recordsPerZone when smaller than template", () => {
    const z = generateZones({
      namePrefix: "s",
      baseDomain: "t",
      count: 1,
      recordsPerZone: 3,
    });
    // 3 records → 1 rrset (apex A with 2 records) + 1 rrset (www A)
    let total = 0;
    for (const rr of z[0]!.rrsets) total += rr.records!.length;
    expect(total).toBe(3);
  });

  it("emits NS hostnames at the requested apex", () => {
    const z = generateZones({
      namePrefix: "n",
      baseDomain: "demo",
      count: 1,
      recordsPerZone: 5,
    });
    expect(z[0]!.nameservers).toEqual(["ns1.demo.", "ns2.demo."]);
  });

  it("varies the third octet across zones so they don't all collide", () => {
    const z = generateZones({
      namePrefix: "o",
      baseDomain: "t",
      count: 3,
      recordsPerZone: 10,
    });
    const apexA1 = z[0]!.rrsets.find((r) => r.name === z[0]!.name && r.type === "A")!;
    const apexA2 = z[1]!.rrsets.find((r) => r.name === z[1]!.name && r.type === "A")!;
    expect(apexA1.records![0]!.content).toBe("10.0.1.1");
    expect(apexA2.records![0]!.content).toBe("10.0.2.1");
  });
});
