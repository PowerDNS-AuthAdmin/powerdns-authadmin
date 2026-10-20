/**
 * components/domain/ptr-links-format.ts
 *
 * Types and pure label logic for the reverse-DNS cross-link chips that the
 * record tables hang off A/AAAA rows (forward zones) and PTR rows (reverse
 * zones). The shapes mirror the wire contract of
 * `GET /api/admin/pdns/auto-ptr/links`; they are redeclared here rather than
 * imported from the route so `components/` stays clear of the server-only
 * layers behind it.
 *
 * Kept free of React so the label rules are unit-testable in the plain node
 * project; `ptr-links.tsx` renders what this module decides.
 */

export interface ForwardLink {
  zone: string;
  server: string;
  name: string;
  type: "A" | "AAAA";
  href: string;
}

export interface AddressLink {
  owner: string;
  reverseZone: string | null;
  reverseServer: string | null;
  href: string | null;
  /**
   * Current PTR targets; `[]` means no PTR exists. Absent when the caller may
   * not read the reverse zone (`status: "unreadable"`).
   */
  targets?: string[];
  status: "ok" | "missing" | "mismatch" | "unhosted" | "unreadable";
}

export interface OwnerLink {
  ip: string;
  targets: string[];
  forward: ForwardLink[];
  status: "ok" | "stale" | "orphan";
}

export type PtrLinksData =
  | { kind: "forward"; zone: string; byAddress: Record<string, AddressLink> }
  | { kind: "reverse"; zone: string; byOwner: Record<string, OwnerLink> };

/** Visual weight of a chip; mapped to design tokens by the renderer. */
export type ChipTone = "ok" | "warn" | "muted";

export interface AddressChipModel {
  tone: ChipTone;
  /** Visible chip text, e.g. "PTR ✓ host.example.com." */
  label: string;
  title: string;
  /** Reverse zone page; `null` renders an unlinked chip. */
  href: string | null;
  /** Every PTR target when there is more than one (the chip shows the first). */
  allTargets: string[];
}

export interface OwnerChipModel {
  tone: ChipTone;
  label: string;
  title: string;
  /** Set when exactly one forward record exists: the chip links straight to it. */
  href: string | null;
  /** Forward records to list in a popover when there are several. */
  entries: Array<ForwardLink & { matchesPtr: boolean }>;
}

/** Forward-zone lookup. `value` is the A/AAAA content exactly as stored. */
export function lookupAddressLink(
  data: PtrLinksData | null,
  value: string,
): AddressLink | undefined {
  if (data?.kind !== "forward") return undefined;
  return data.byAddress[value];
}

/** Reverse-zone lookup. Owner keys on the wire are lowercase. */
export function lookupOwnerLink(data: PtrLinksData | null, name: string): OwnerLink | undefined {
  if (data?.kind !== "reverse") return undefined;
  return data.byOwner[name.toLowerCase()];
}

/**
 * Decide what the chip on an A/AAAA row says. Returns `null` for the states
 * that render nothing: no data yet, an address no hosted reverse zone covers,
 * or a reverse zone the caller may not read.
 *
 * @param recordName owner of the A/AAAA row, used to pick which of several
 *   PTR targets the "matches" chip shows.
 */
export function addressChipModel(
  link: AddressLink | undefined,
  recordName?: string,
): AddressChipModel | null {
  if (!link) return null;
  const targets = link.targets ?? [];
  switch (link.status) {
    case "ok": {
      const wanted = recordName?.toLowerCase();
      const shown = targets.find((t) => t.toLowerCase() === wanted) ?? targets[0] ?? "";
      return {
        tone: "ok",
        label: `PTR ✓ ${shown}`,
        title: "Reverse record matches",
        href: link.href,
        allTargets: targets.length > 1 ? targets : [],
      };
    }
    case "missing":
      return {
        tone: "warn",
        label: "no PTR",
        title: `No reverse record for this address in ${link.reverseZone ?? "its reverse zone"}`,
        href: link.href,
        allTargets: [],
      };
    case "mismatch": {
      const first = targets[0] ?? "";
      const extra = targets.length - 1;
      return {
        tone: "warn",
        label: extra > 0 ? `PTR → ${first} +${extra}` : `PTR → ${first}`,
        title:
          extra > 0
            ? `The reverse record points at ${targets.length} other names`
            : `The reverse record points at ${first}, not at this name`,
        href: link.href,
        allTargets: targets.length > 1 ? targets : [],
      };
    }
    case "unhosted":
    case "unreadable":
      return null;
  }
}

/**
 * Decide what the chip on a PTR row says. Always renders something once data
 * is present: a reverse zone's whole point is to be cross-checked, so even
 * "nothing points here" is worth a muted chip.
 */
export function ownerChipModel(link: OwnerLink | undefined): OwnerChipModel | null {
  if (!link) return null;
  const targets = new Set(link.targets.map((t) => t.toLowerCase()));
  const entries = link.forward.map((f) => ({
    ...f,
    matchesPtr: targets.has(f.name.toLowerCase()),
  }));
  const first = entries[0];

  if (link.status === "orphan" || !first) {
    return {
      tone: "muted",
      label: "no A/AAAA",
      title: `No readable A/AAAA record points at ${link.ip}`,
      href: null,
      entries: [],
    };
  }

  if (entries.length === 1) {
    return link.status === "ok"
      ? {
          tone: "ok",
          label: `${first.type} ${first.name}`,
          title: `Forward record ${first.name} points here`,
          href: first.href,
          entries: [],
        }
      : {
          tone: "warn",
          label: `${first.type} → ${first.name}`,
          title: `The PTR target has no ${first.type} record here; ${first.name} points here instead`,
          href: first.href,
          entries: [],
        };
  }

  return link.status === "ok"
    ? {
        tone: "ok",
        label: `${entries.length} names`,
        title: `${entries.length} forward records point at ${link.ip}`,
        href: null,
        entries,
      }
    : {
        tone: "warn",
        label: `${first.type} → ${first.name} +${entries.length - 1}`,
        title: `The PTR target has no address record here; ${entries.length} other names point at ${link.ip}`,
        href: null,
        entries,
      };
}
