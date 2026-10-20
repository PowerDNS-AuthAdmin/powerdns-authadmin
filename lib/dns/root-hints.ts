/**
 * lib/dns/root-hints.ts
 *
 * The root nameserver addresses (IANA root hints, last changed 2017 for
 * IPv6 on h.root-servers.net; the IPv4 set has been stable for longer).
 * Zone monitoring starts its delegation walk here instead of trusting a
 * recursive resolver, so a lying or broken resolver cannot make a correct
 * delegation look wrong. The list is small and public; if it ever changes,
 * IANA's https://www.internic.net/domain/named.root is the source.
 */

export interface RootHint {
  name: string;
  v4: string;
  v6: string;
}

export const ROOT_HINTS: readonly RootHint[] = [
  { name: "a.root-servers.net.", v4: "198.41.0.4", v6: "2001:503:ba3e::2:30" },
  { name: "b.root-servers.net.", v4: "170.247.170.2", v6: "2801:1b8:10::b" },
  { name: "c.root-servers.net.", v4: "192.33.4.12", v6: "2001:500:2::c" },
  { name: "d.root-servers.net.", v4: "199.7.91.13", v6: "2001:500:2d::d" },
  { name: "e.root-servers.net.", v4: "192.203.230.10", v6: "2001:500:a8::e" },
  { name: "f.root-servers.net.", v4: "192.5.5.241", v6: "2001:500:2f::f" },
  { name: "g.root-servers.net.", v4: "192.112.36.4", v6: "2001:500:12::d0d" },
  { name: "h.root-servers.net.", v4: "198.97.190.53", v6: "2001:500:1::53" },
  { name: "i.root-servers.net.", v4: "192.36.148.17", v6: "2001:7fe::53" },
  { name: "j.root-servers.net.", v4: "192.58.128.30", v6: "2001:503:c27::2:30" },
  { name: "k.root-servers.net.", v4: "193.0.14.129", v6: "2001:7fd::1" },
  { name: "l.root-servers.net.", v4: "199.7.83.42", v6: "2001:500:9f::42" },
  { name: "m.root-servers.net.", v4: "202.12.27.33", v6: "2001:dc3::35" },
];

/** A rotated copy so repeated walks spread load across the roots. */
export function rootAddresses(seed = Date.now()): string[] {
  const v4 = ROOT_HINTS.map((h) => h.v4);
  const start = Math.abs(seed) % v4.length;
  return [...v4.slice(start), ...v4.slice(0, start)];
}
