## lib/health

Pure backend-health evaluation logic used to turn observed PowerDNS state into
operator-facing advisories.

This directory computes verdicts. Polling, persistence, and SSE fan-out are
handled by `lib/realtime` and database repositories.

- `notifications.ts` - the notification list behind the bell and `/notifications`: per-row
  visibility (backend health needs `server.read`, a zone-monitoring finding needs `zone.read`
  on its zone), ordering, summary counts and the bell preview. Pure.
- `load-notifications.ts` - server-only loader that applies that rule for an authenticated
  user; the bell, the page, the JSON route, the dismiss route and MCP all go through it.
