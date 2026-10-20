## lib/monitoring

Background checks that look at the fleet from the outside and keep their
results in memory:

- `zone-monitor.ts` - one cycle per `ZONE_MONITOR_INTERVAL_SECONDS`: every
  hosted zone is probed (delegation walked from the root servers, nameserver
  answers, DNSSEC chain, resolver view, open AXFR, reverse-DNS tally) and judged
  by `lib/dns/zone-checks.ts`. Findings feed the Zone Monitoring page, the
  sidebar badges and, as `monitor.<zone>.<code>` advisories, the bell.
- `external-ptr.ts` - what public or internal resolvers answer for addresses
  the installation cannot host a PTR for, looked up a few at a time and cached.

Both are started lazily from the app shell, run one cycle at a time, bound
every query by a timeout, and rate-limit operator-triggered refreshes. They
read PowerDNS through the shared fleet scan (`app/api/admin/pdns/auto-ptr/_scan.ts`)
and never write to it.
