## lib/dns

DNS text-format and zone-file helpers: name normalization, SOA serials, TXT
escaping, BIND formatting, and zone-file parsing.

Keep protocol parsing and formatting here. PowerDNS HTTP behavior belongs under
`lib/pdns`, and request validation belongs under `lib/validators`.

Reverse DNS and monitoring live here too, as pure modules with their I/O
injected: `reverse-name.ts` (address ↔ PTR owner, RFC 2317 classless zones),
`auto-ptr.ts` and `auto-ptr-setting.ts` (the PTR decision table and the
global / per-zone / per-save switch), `ptr-reconcile.ts` (the fleet-wide
reverse diff), `wire.ts` (a small DNS wire client), `root-hints.ts` and
`delegation.ts` (the delegation walk from the roots) and `zone-checks.ts`
(zone findings). Orchestration with real sockets and PowerDNS is in
`lib/monitoring` and next to the RRset route.
