/**
 * lib/dns/delegation.ts
 *
 * Find a zone's delegation the way a resolver does: start at the root
 * servers and follow referrals down until a parent hands out the NS set for
 * the zone itself. The parent's view is the one that matters for "is my
 * delegation right" - it is what every resolver on the internet sees - and it
 * is never visible through a recursive resolver's cache.
 *
 * Returns the delegation NS set, the glue the parent serves for them, the DS
 * records (if any) and the parent servers that answered, so the caller can
 * compare against the zone's own apex and DNSKEYs.
 *
 * I/O goes through an injected `query` so the walk is unit-tested with a
 * scripted internet; `lib/monitoring` plugs in the wire client.
 */

import type { WireMessage, WireRecord } from "./wire";

export type DelegationQuery = (name: string, type: string, server: string) => Promise<WireMessage>;

export interface DelegationResult {
  zone: string;
  /** How the walk ended. */
  status: "delegated" | "not-delegated" | "unreachable" | "served-by-parent";
  /** NS names the parent delegates the zone to (lowercase, trailing dot). */
  nameservers: string[];
  /** Glue the parent serves: nameserver name -> addresses. */
  glue: Record<string, string[]>;
  /** DS records the parent serves for the zone. */
  ds: Array<{ keyTag: number; algorithm: number; digestType: number; digest: string }>;
  /** The parent-zone servers that answered (addresses). */
  parentServers: string[];
  /** Zone names the walk passed through, root first. */
  path: string[];
  /** Why `unreachable`, when it is. */
  error?: string;
}

export interface DelegationOptions {
  /** Sends one query to one server and decodes the reply (the wire client, or a scripted fake). */
  query: DelegationQuery;
  /** Addresses to start from (root hints). */
  rootServers: readonly string[];
  /** Resolve a nameserver name to addresses when the referral carried no glue. */
  lookup: (name: string) => Promise<string[]>;
  /** How many servers of one level to try before giving up on the level. */
  attemptsPerLevel?: number;
  /** Levels to walk at most (labels in the zone name plus the root). */
  maxDepth?: number;
}

const lower = (s: string): string => s.toLowerCase();

function isSuffix(zone: string, parent: string): boolean {
  if (parent === ".") return true;
  return zone === parent || zone.endsWith(`.${parent}`);
}

function glueFrom(additional: readonly WireRecord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of additional) {
    if (r.type !== "A" && r.type !== "AAAA") continue;
    (out[lower(r.name)] ??= []).push(r.data);
  }
  return out;
}

/**
 * Walk from the roots to the parent of `zone`. The referral chain is followed
 * by the zone it points at: a referral whose NS owner is the zone itself is
 * the delegation; one whose owner is a longer suffix of the zone is the next
 * hop; an authoritative answer for the zone from a parent-level server means
 * the parent serves the zone directly (no delegation to compare).
 */
export async function findDelegation(
  zone: string,
  opts: DelegationOptions,
): Promise<DelegationResult> {
  const target = lower(zone.endsWith(".") ? zone : `${zone}.`);
  const attempts = opts.attemptsPerLevel ?? 4;
  const maxDepth = opts.maxDepth ?? target.split(".").length + 1;
  let servers = [...opts.rootServers];
  let current = ".";
  const path: string[] = ["."];
  let lastError = "";

  for (let depth = 0; depth < maxDepth; depth++) {
    let answered: WireMessage | null = null;
    let from = "";
    let tried = 0;
    for (const server of servers) {
      if (tried++ >= attempts) break;
      try {
        answered = await opts.query(target, "NS", server);
        from = server;
        break;
      } catch (err) {
        lastError = `${server}: ${err instanceof Error ? err.message : "unknown"}`;
      }
    }
    if (!answered) {
      return {
        zone: target,
        status: "unreachable",
        nameservers: [],
        glue: {},
        ds: [],
        parentServers: [],
        path,
        error: lastError || "no server answered",
      };
    }

    if (answered.rcode === 3) {
      return {
        zone: target,
        status: "not-delegated",
        nameservers: [],
        glue: {},
        ds: [],
        parentServers: [from],
        path,
      };
    }

    const parentServers = servers.slice(0, Math.min(servers.length, attempts));
    const readDs = async (): Promise<DelegationResult["ds"]> => {
      try {
        const m = await opts.query(target, "DS", from);
        return m.answer
          .filter((r) => r.type === "DS" && lower(r.name) === target && r.ds)
          .map((r) => r.ds!);
      } catch {
        return [];
      }
    };

    // Authoritative answer for the zone from this level: the server we asked
    // is authoritative for the zone itself (parent serves it, or we asked the
    // child). The NS set in the answer is the apex set, not a delegation.
    if (answered.aa && answered.answer.some((r) => r.type === "NS" && lower(r.name) === target)) {
      const nameservers = answered.answer
        .filter((r) => r.type === "NS" && lower(r.name) === target)
        .map((r) => lower(r.data));
      return {
        zone: target,
        status: current === target ? "delegated" : "served-by-parent",
        nameservers,
        glue: glueFrom(answered.additional),
        ds: current === target ? [] : await readDs(),
        parentServers,
        path,
      };
    }

    const referralNs = answered.authority.filter((r) => r.type === "NS");
    if (referralNs.length === 0) {
      // No referral and no answer: this level claims the name but has nothing
      // for it (empty non-terminal, or a resolver that will not recurse).
      return {
        zone: target,
        status: "not-delegated",
        nameservers: [],
        glue: {},
        ds: [],
        parentServers: [from],
        path,
        error: `${from} returned ${answered.rcodeName} with no referral`,
      };
    }
    const owner = lower(referralNs[0]!.name);
    if (
      !isSuffix(target, owner) ||
      (owner !== target && owner.length <= current.length && current !== ".")
    ) {
      return {
        zone: target,
        status: "not-delegated",
        nameservers: [],
        glue: {},
        ds: [],
        parentServers: [from],
        path,
        error: `${from} referred to ${owner}, which is not on the path to ${target}`,
      };
    }
    const nameservers = [
      ...new Set(referralNs.filter((r) => lower(r.name) === owner).map((r) => lower(r.data))),
    ];
    const glue = glueFrom(answered.additional);
    if (owner === target) {
      const ds = answered.authority
        .filter((r) => r.type === "DS" && lower(r.name) === target && r.ds)
        .map((r) => r.ds!);
      return {
        zone: target,
        status: "delegated",
        nameservers,
        glue,
        ds: ds.length ? ds : await readDs(),
        parentServers,
        path,
      };
    }

    // Next hop: the referral's nameservers, glue first, then resolved.
    const next: string[] = [];
    for (const ns of nameservers) {
      const addrs = glue[ns] ?? [];
      if (addrs.length === 0) {
        try {
          addrs.push(...(await opts.lookup(ns)));
        } catch {
          // a nameserver without any address is skipped
        }
      }
      next.push(...addrs);
    }
    if (next.length === 0) {
      return {
        zone: target,
        status: "unreachable",
        nameservers: [],
        glue: {},
        ds: [],
        parentServers: [from],
        path,
        error: `no address for the nameservers of ${owner}`,
      };
    }
    servers = next;
    current = owner;
    path.push(owner);
  }
  return {
    zone: target,
    status: "unreachable",
    nameservers: [],
    glue: {},
    ds: [],
    parentServers: [],
    path,
    error: "delegation chain too deep",
  };
}
