import { describe, expect, it } from "vitest";
import {
  addressChipModel,
  lookupAddressLink,
  lookupOwnerLink,
  ownerChipModel,
  type AddressLink,
  type OwnerLink,
  type PtrLinksData,
} from "./ptr-links-format";

const forwardOf = (name: string, type: "A" | "AAAA" = "A") => ({
  zone: "example.com.",
  server: "primary",
  name,
  type,
  href: `/zones/example.com.?server=primary#${name}`,
});

describe("addressChipModel", () => {
  const base: AddressLink = {
    owner: "1.2.0.192.in-addr.arpa.",
    reverseZone: "2.0.192.in-addr.arpa.",
    reverseServer: "primary",
    href: "/zones/2.0.192.in-addr.arpa.?server=primary",
    status: "ok",
  };

  it("renders nothing without data or for addresses the caller cannot follow", () => {
    expect(addressChipModel(undefined)).toBeNull();
    expect(addressChipModel({ ...base, status: "unhosted", href: null })).toBeNull();
    expect(addressChipModel({ ...base, status: "unreadable", href: null })).toBeNull();
  });

  it("shows the matching target first when the PTR agrees", () => {
    const model = addressChipModel(
      { ...base, status: "ok", targets: ["other.example.com.", "www.example.com."] },
      "WWW.example.com.",
    );
    expect(model?.tone).toBe("ok");
    expect(model?.label).toBe("PTR ✓ www.example.com.");
    expect(model?.href).toBe(base.href);
    expect(model?.allTargets).toHaveLength(2);
  });

  it("warns and links to the reverse zone when the PTR is missing", () => {
    const model = addressChipModel({ ...base, status: "missing", targets: [] });
    expect(model).toMatchObject({ tone: "warn", label: "no PTR", href: base.href });
  });

  it("summarises several mismatched targets as first +n", () => {
    const one = addressChipModel({ ...base, status: "mismatch", targets: ["a.example.net."] });
    expect(one?.label).toBe("PTR → a.example.net.");
    expect(one?.allTargets).toEqual([]);

    const many = addressChipModel({
      ...base,
      status: "mismatch",
      targets: ["a.example.net.", "b.example.net.", "c.example.net."],
    });
    expect(many?.label).toBe("PTR → a.example.net. +2");
    expect(many?.allTargets).toHaveLength(3);
  });
});

describe("ownerChipModel", () => {
  const base: OwnerLink = {
    ip: "192.0.2.1",
    targets: ["www.example.com."],
    forward: [],
    status: "orphan",
  };

  it("renders a muted unlinked chip for orphans", () => {
    expect(ownerChipModel(base)).toMatchObject({ tone: "muted", label: "no A/AAAA", href: null });
    expect(ownerChipModel(undefined)).toBeNull();
  });

  it("links straight to a single matching forward record", () => {
    const model = ownerChipModel({
      ...base,
      status: "ok",
      forward: [forwardOf("www.example.com.", "AAAA")],
    });
    expect(model).toMatchObject({
      tone: "ok",
      label: "AAAA www.example.com.",
      href: forwardOf("www.example.com.").href,
    });
    expect(model?.entries).toEqual([]);
  });

  it("marks stale PTRs with an arrow", () => {
    const model = ownerChipModel({
      ...base,
      status: "stale",
      forward: [forwardOf("old.example.com.")],
    });
    expect(model).toMatchObject({ tone: "warn", label: "A → old.example.com." });
  });

  it("collapses several names into a popover and flags the PTR target", () => {
    const model = ownerChipModel({
      ...base,
      status: "ok",
      forward: [forwardOf("mail.example.com."), forwardOf("www.example.com.")],
    });
    expect(model).toMatchObject({ tone: "ok", label: "2 names", href: null });
    expect(model?.entries.map((e) => e.matchesPtr)).toEqual([false, true]);
  });
});

describe("lookups", () => {
  const forward: PtrLinksData = {
    kind: "forward",
    zone: "example.com.",
    byAddress: {
      "192.0.2.1": {
        owner: "1.2.0.192.in-addr.arpa.",
        reverseZone: null,
        reverseServer: null,
        href: null,
        status: "unhosted",
      },
    },
  };
  const reverse: PtrLinksData = {
    kind: "reverse",
    zone: "2.0.192.in-addr.arpa.",
    byOwner: {
      "1.2.0.192.in-addr.arpa.": { ip: "192.0.2.1", targets: [], forward: [], status: "orphan" },
    },
  };

  it("only answer for the matching zone kind", () => {
    expect(lookupAddressLink(forward, "192.0.2.1")?.status).toBe("unhosted");
    expect(lookupAddressLink(reverse, "192.0.2.1")).toBeUndefined();
    expect(lookupAddressLink(null, "192.0.2.1")).toBeUndefined();
    expect(lookupOwnerLink(reverse, "1.2.0.192.IN-ADDR.ARPA.")?.ip).toBe("192.0.2.1");
    expect(lookupOwnerLink(forward, "1.2.0.192.in-addr.arpa.")).toBeUndefined();
  });
});
