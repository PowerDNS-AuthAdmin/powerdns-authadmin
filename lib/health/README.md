## lib/health

Pure backend-health evaluation logic used to turn observed PowerDNS state into
operator-facing advisories.

This directory computes verdicts. Polling, persistence, and SSE fan-out are
handled by `lib/realtime` and database repositories.
