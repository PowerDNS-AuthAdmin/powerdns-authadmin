/**
 * lib/dns/zone-checks.ts
 *
 * Zone monitoring's decision table: given what the prober observed about one
 * zone (its PowerDNS copy, the parent's delegation, every nameserver's
 * answers, the resolvers' view, the reverse-DNS tally), produce findings.
 *
 * The checks follow the areas a delegation-health tool such as Zonemaster
 * covers - delegation, nameserver, consistency, zone (SOA), DNSSEC, plus the
 * things an operator of PowerDNS specifically cares about: open zone
 * transfers and reverse-DNS drift. Each finding has a stable code, a severity
 * and enough detail to act on. Severity policy:
 *   error - resolvers are, or soon will be, failing to answer for the zone
 *   warn  - the zone works but is fragile or inconsistent
 *   info  - worth knowing, nothing to fix today
 *
 * Pure: `lib/monitoring/zone-monitor.ts` gathers, this file judges.
 */

import type { DelegationResult } from "./delegation";
import type { AxfrProbe, SoaRdata } from "./wire";
import type { ZoneHorizon } from "./zone-horizon";

export type FindingSeverity = "error" | "warn" | "info";

export interface ZoneFinding {
  /** Stable rule id, e.g. "delegation.ns-mismatch". */
  code: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
}

export interface NameserverProbe {
  address: string;
  /** Reached the server and got a DNS answer. */
  ok: boolean;
  aa?: boolean;
  rcodeName?: string;
  serial?: number | null;
  /** NS names the server answered for the apex. */
  nsSet?: string[];
  axfr?: AxfrProbe | null;
  error?: string;
}

export interface NameserverObservation {
  name: string;
  addresses: string[];
  /** Addresses in loopback / RFC 1918 / ULA space. */
  privateAddresses: string[];
  /** True when the name is a CNAME (RFC 2181 §10.3 forbids NS targets that are). */
  isCname?: boolean;
  probes: NameserverProbe[];
}

export interface ResolverObservation {
  address: string;
  kind: "public" | "internal";
  ok: boolean;
  rcodeName?: string;
  serial?: number | null;
  error?: string;
}

export interface ZoneProbeData {
  zone: string;
  horizon: ZoneHorizon;
  pdns: {
    serial: number | null;
    soa: SoaRdata | null;
    nsNames: string[];
    /** DNSKEY key tags + algorithms published by PowerDNS, empty when unsigned. */
    dnskeys: Array<{ keyTag: number; algorithm: number }>;
    /** A/AAAA the zone itself holds for in-bailiwick nameservers. */
    glue: Record<string, string[]>;
  };
  /** Null when the walk was not attempted (internal zone, monitoring offline). */
  delegation: DelegationResult | null;
  nameservers: NameserverObservation[];
  resolvers: ResolverObservation[];
  reverse?: { addresses: number; missing: number; mismatch: number } | null;
}

const lower = (s: string): string => s.toLowerCase();
const list = (items: readonly string[]): string => items.join(", ");
const setDiff = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((x) => !b.includes(x));

/** /24 for IPv4, /48 for IPv6: "same network" for the diversity check. */
export function networkKey(address: string): string {
  if (address.includes(":")) {
    const groups = address.split(":");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return `${address.split(".").slice(0, 3).join(".")}.0/24`;
}

export function evaluateZone(data: ZoneProbeData): ZoneFinding[] {
  const out: ZoneFinding[] = [];
  const apexNs = [...new Set(data.pdns.nsNames.map(lower))].sort();
  const isPublic = data.horizon === "public";

  // --- delegation (public zones) ---------------------------------------------
  const d = data.delegation;
  if (d) {
    if (d.status === "unreachable") {
      out.push({
        code: "delegation.unverified",
        severity: "info",
        title: "Delegation could not be verified",
        detail: `The walk from the root servers failed: ${d.error ?? "no answer"}. Outbound DNS from the AuthAdmin host may be blocked.`,
      });
    } else if (d.status === "not-delegated") {
      out.push({
        code: "delegation.missing",
        severity: "error",
        title: "Zone is not delegated",
        detail: `The parent zone (${d.path[d.path.length - 1] ?? "."}) does not delegate ${data.zone}${d.error ? `: ${d.error}` : ""}. Resolvers on the internet cannot reach this zone.`,
      });
    } else if (d.status === "served-by-parent") {
      out.push({
        code: "delegation.served-by-parent",
        severity: "info",
        title: "Parent serves the zone directly",
        detail: `The parent's nameservers answer authoritatively for ${data.zone} (${list(d.nameservers)}); there is no separate delegation to compare.`,
      });
    } else {
      const parentNs = [...new Set(d.nameservers.map(lower))].sort();
      const missingAtParent = setDiff(apexNs, parentNs);
      const extraAtParent = setDiff(parentNs, apexNs);
      if (missingAtParent.length || extraAtParent.length) {
        const overlap = apexNs.filter((n) => parentNs.includes(n));
        out.push({
          code: "delegation.ns-mismatch",
          severity: overlap.length === 0 ? "error" : "warn",
          title:
            overlap.length === 0
              ? "Delegation points at other nameservers"
              : "Delegation and zone NS sets differ",
          detail:
            `Parent delegates to: ${list(parentNs)}. Zone apex lists: ${list(apexNs)}.` +
            (extraAtParent.length
              ? ` Delegated but not in the zone: ${list(extraAtParent)}.`
              : "") +
            (missingAtParent.length
              ? ` In the zone but not delegated: ${list(missingAtParent)}.`
              : ""),
        });
      }
      for (const [ns, parentAddrs] of Object.entries(d.glue)) {
        const zoneAddrs = data.pdns.glue[ns];
        if (!zoneAddrs || !apexNs.includes(ns)) continue;
        const a = [...parentAddrs].sort();
        const b = [...zoneAddrs].sort();
        if (a.join() !== b.join()) {
          out.push({
            code: "delegation.glue-mismatch",
            severity: "warn",
            title: `Glue for ${ns} differs from the zone`,
            detail: `Parent glue: ${list(a)}. Zone: ${list(b)}. Update the glue at the registrar/parent.`,
          });
        }
      }
      // --- DNSSEC chain ---
      const keys = data.pdns.dnskeys;
      if (d.ds.length === 0 && keys.length > 0) {
        out.push({
          code: "dnssec.ds-missing",
          severity: "warn",
          title: "Signed zone without DS at the parent",
          detail: `The zone publishes ${keys.length} DNSKEY(s) but the parent has no DS record, so validators treat it as unsigned. Publish the DS (key tags ${list(keys.map((k) => String(k.keyTag)))}) at the registrar to complete the chain of trust.`,
        });
      } else if (d.ds.length > 0 && keys.length === 0) {
        out.push({
          code: "dnssec.ds-orphan",
          severity: "error",
          title: "DS at the parent but the zone is unsigned",
          detail: `The parent publishes DS (key tags ${list(d.ds.map((x) => String(x.keyTag)))}) and the zone serves no DNSKEY. Validating resolvers return SERVFAIL for every name in the zone. Remove the DS or re-sign the zone.`,
        });
      } else if (d.ds.length > 0) {
        const matched = d.ds.some((ds) =>
          keys.some((k) => k.keyTag === ds.keyTag && k.algorithm === ds.algorithm),
        );
        if (!matched) {
          out.push({
            code: "dnssec.ds-stale",
            severity: "error",
            title: "DS at the parent matches no DNSKEY",
            detail: `Parent DS key tags: ${list(d.ds.map((x) => `${x.keyTag}/${x.algorithm}`))}. Zone DNSKEY tags: ${list(keys.map((k) => `${k.keyTag}/${k.algorithm}`))}. Validation fails until the DS is updated (key rollover not completed).`,
          });
        }
      }
    }
  }

  // --- nameservers ------------------------------------------------------------
  if (apexNs.length === 0) {
    out.push({
      code: "nameserver.none",
      severity: "error",
      title: "No NS records at the apex",
      detail: "The zone has no NS RRset at its apex, so it cannot be served.",
    });
  } else if (apexNs.length < 2) {
    out.push({
      code: "nameserver.count",
      severity: "warn",
      title: "Only one nameserver",
      detail: `Only ${apexNs[0]} serves the zone; a second, independent nameserver keeps the zone resolvable through maintenance and outages (RFC 2182).`,
    });
  }
  const serials = new Map<string, number | null>();
  const allAddresses: string[] = [];
  for (const ns of data.nameservers) {
    if (ns.isCname) {
      out.push({
        code: "nameserver.cname",
        severity: "warn",
        title: `${ns.name} is a CNAME`,
        detail:
          "An NS target must be a hostname with address records, not an alias (RFC 2181 §10.3).",
      });
    }
    if (ns.addresses.length === 0) {
      out.push({
        code: "nameserver.no-address",
        severity: "error",
        title: `${ns.name} has no address`,
        detail:
          "The nameserver name does not resolve to any A/AAAA record, so nobody can query it.",
      });
      continue;
    }
    allAddresses.push(...ns.addresses);
    if (isPublic && ns.privateAddresses.length) {
      out.push({
        code: "nameserver.private-address",
        severity: "warn",
        title: `${ns.name} resolves to a private address`,
        detail: `${list(ns.privateAddresses)} is not reachable from the internet, so this nameserver cannot serve a public zone.`,
      });
    }
    const probed = ns.probes;
    if (probed.length === 0) continue;
    const down = probed.filter((p) => !p.ok);
    if (down.length === probed.length) {
      out.push({
        code: "nameserver.unreachable",
        severity: "error",
        title: `${ns.name} did not answer`,
        detail: list(down.map((p) => `${p.address}: ${p.error ?? "no answer"}`)),
      });
      continue;
    }
    if (down.length) {
      out.push({
        code: "nameserver.partially-unreachable",
        severity: "warn",
        title: `${ns.name}: some addresses did not answer`,
        detail: list(down.map((p) => `${p.address}: ${p.error ?? "no answer"}`)),
      });
    }
    for (const p of probed.filter((p) => p.ok)) {
      if (p.rcodeName !== "NOERROR" || p.aa === false) {
        out.push({
          code: "nameserver.lame",
          severity: "error",
          title: `${ns.name} is not authoritative`,
          detail: `${p.address} answered ${p.rcodeName ?? "?"}${p.aa === false ? " without the AA flag" : ""} for the zone's SOA. The delegation points at a server that does not serve the zone.`,
        });
        continue;
      }
      serials.set(`${ns.name} (${p.address})`, p.serial ?? null);
      if (p.nsSet?.length) {
        const theirs = [...new Set(p.nsSet.map(lower))].sort();
        if (theirs.join() !== apexNs.join()) {
          out.push({
            code: "consistency.ns-set",
            severity: "warn",
            title: `${ns.name} serves a different NS set`,
            detail: `${p.address} answers NS ${list(theirs)}; PowerDNS holds ${list(apexNs)}.`,
          });
        }
      }
      if (p.axfr?.result === "open") {
        out.push({
          code: "transfer.open",
          severity: isPublic ? "error" : "warn",
          title: `${ns.name} allows zone transfers without a key`,
          detail: `${p.address} answered an unsigned AXFR for ${data.zone} with ${p.axfr.records} record(s) in the first message. Restrict transfers with allow-axfr-ips / TSIG (ALLOW-AXFR-FROM metadata on PowerDNS).`,
        });
      }
    }
  }
  if (allAddresses.length > 1) {
    const nets = new Set(allAddresses.map(networkKey));
    if (nets.size === 1) {
      out.push({
        code: "nameserver.diversity",
        severity: "info",
        title: "All nameservers share one network",
        detail: `Every nameserver address is in ${[...nets][0]}; one network outage takes the whole zone offline (RFC 2182 §3.1).`,
      });
    }
  }
  const seen = [...serials.entries()].filter(([, s]) => s !== null) as Array<[string, number]>;
  const distinct = new Set(seen.map(([, s]) => s));
  if (
    distinct.size > 1 ||
    (seen.length && data.pdns.serial !== null && seen.some(([, s]) => s !== data.pdns.serial))
  ) {
    out.push({
      code: "consistency.serial",
      severity: "warn",
      title: "Nameservers disagree on the serial",
      detail: `PowerDNS: ${data.pdns.serial ?? "?"}. ${seen.map(([k, s]) => `${k}: ${s}`).join("; ")}. A secondary may be failing to transfer, or NOTIFY is not reaching it.`,
    });
  }

  // --- SOA ----------------------------------------------------------------------
  const soa = data.pdns.soa;
  if (soa) {
    const t: string[] = [];
    if (soa.refresh < 1200) t.push(`refresh ${soa.refresh}s is below 20 minutes`);
    if (soa.retry >= soa.refresh)
      t.push(`retry ${soa.retry}s is not below refresh ${soa.refresh}s`);
    if (soa.expire <= soa.refresh + soa.retry)
      t.push(`expire ${soa.expire}s is not above refresh + retry`);
    else if (soa.expire < 604800) t.push(`expire ${soa.expire}s is below one week`);
    if (soa.minimum > 86400)
      t.push(`minimum (negative-caching TTL) ${soa.minimum}s is above one day`);
    if (t.length) {
      out.push({
        code: "soa.timers",
        severity: soa.expire <= soa.refresh + soa.retry ? "error" : "warn",
        title: "SOA timers outside recommended ranges",
        detail: `${t.join("; ")} (RFC 1912 §2.2, RFC 2308 §4).`,
      });
    }
    if (apexNs.length && !apexNs.includes(lower(soa.mname))) {
      out.push({
        code: "soa.mname",
        severity: "warn",
        title: "SOA MNAME is not one of the nameservers",
        detail: `MNAME ${soa.mname} is not in the NS set (${list(apexNs)}); NOTIFY and dynamic updates target the primary named here (RFC 1996).`,
      });
    }
    const rname = soa.rname.replace(/\.$/, "");
    if (!rname.includes(".") || rname.includes("@")) {
      out.push({
        code: "soa.rname",
        severity: "info",
        title: "SOA RNAME looks wrong",
        detail: `RNAME ${soa.rname} should be a mailbox with the "@" written as "." (hostmaster.example.com.).`,
      });
    }
  } else {
    out.push({
      code: "soa.missing",
      severity: "error",
      title: "No SOA record",
      detail: "The zone has no SOA at the apex.",
    });
  }

  // --- resolvers -----------------------------------------------------------------
  for (const r of data.resolvers) {
    if (!r.ok) {
      out.push({
        code: `resolution.${r.kind}`,
        severity: r.kind === "public" && isPublic ? "warn" : "info",
        title: `${r.kind === "public" ? "Public" : "Internal"} resolver ${r.address} did not answer`,
        detail: r.error ?? "no answer",
      });
      continue;
    }
    if (r.rcodeName === "SERVFAIL") {
      out.push({
        code: `resolution.${r.kind}`,
        severity: "error",
        title: `${r.address} returns SERVFAIL for the zone`,
        detail:
          "A validating resolver fails the zone: broken DNSSEC chain, lame delegation or every nameserver unreachable from that resolver.",
      });
    } else if (r.rcodeName === "NXDOMAIN") {
      out.push({
        code: `resolution.${r.kind}`,
        severity: "error",
        title: `${r.address} does not know the zone`,
        detail:
          "The resolver answers NXDOMAIN for the zone apex: the delegation is missing from its point of view.",
      });
    } else if (r.rcodeName !== "NOERROR") {
      out.push({
        code: `resolution.${r.kind}`,
        severity: "warn",
        title: `${r.address} answered ${r.rcodeName}`,
        detail: "Unexpected response code for the zone's SOA.",
      });
    } else if (
      r.serial !== null &&
      r.serial !== undefined &&
      data.pdns.serial !== null &&
      r.serial < data.pdns.serial
    ) {
      out.push({
        code: `resolution.${r.kind}.stale`,
        severity: "info",
        title: `${r.address} still caches serial ${r.serial}`,
        detail: `PowerDNS serves ${data.pdns.serial}; the resolver's copy refreshes when its cache expires.`,
      });
    }
  }

  // --- reverse DNS -----------------------------------------------------------------
  if (data.reverse && data.reverse.missing + data.reverse.mismatch > 0) {
    out.push({
      code: "reverse-dns.drift",
      severity: "warn",
      title: "Reverse DNS out of step",
      detail: `${data.reverse.missing} address(es) without a PTR and ${data.reverse.mismatch} with a PTR naming something else, out of ${data.reverse.addresses} in hosted reverse zones. Fix them on the Reverse DNS page.`,
    });
  }

  const order: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
}

/** Worst severity in a list, or null when the zone is clean. */
export function worstSeverity(findings: readonly ZoneFinding[]): FindingSeverity | null {
  if (findings.some((f) => f.severity === "error")) return "error";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  if (findings.length) return "info";
  return null;
}
