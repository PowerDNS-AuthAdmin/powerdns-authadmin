# ADR 0016 — Optional Redis for horizontal scale (replicas > 1)

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** @jseifeddine

## Context

Through 1.0.x the app was implicitly single-instance. Three pieces of state lived
in process memory and were therefore not shared across replicas:

1. **Auth rate limiting** — the login / sensitive-action token buckets
   (`lib/auth/rate-limit.ts`). Per-process buckets mean N replicas multiply the
   effective limit by N, weakening brute-force protection.
2. **One-time reveal tokens** — the short-lived single-use tokens that gate
   revealing a freshly-minted secret once (`lib/auth/temp-reveal-store.ts`). A
   token minted on replica A is unredeemable on replica B.
3. **The realtime SSE event bus** — zone/health/audit/pdns-request events
   (`lib/realtime/event-bus.ts`). An SSE client connected to replica A never sees
   an event emitted on replica B, so live updates silently stop being live.

Sessions were never in this list — they're DB-backed (ADR-0007), so they're
already shared by whatever Postgres the replicas point at. The question was only
how to make the three in-memory pieces cross-replica **without** forcing a
dependency on operators who run a single instance.

## Decision

We add **optional** Redis, gated entirely on a single `REDIS_URL` env var. When
set, the three pieces above coordinate through Redis; when unset, each keeps its
existing in-process implementation. Crucially, each piece _also_ falls back to
in-process if a Redis command fails — a Redis outage degrades coordination, it
never takes the app down.

- **Rate limiting** uses an atomic Lua token-bucket (`EVAL`) so concurrent
  replicas can't race the read-modify-write. Falls back to the in-process bucket
  on failure.
- **Reveal tokens** use `SET key val PX ttl` to mint and `GETDEL` to redeem —
  the atomic redeem is what guarantees single-use across replicas. Falls back to
  the in-process `Map`.
- **The event bus** publishes each event to a `pda:realtime` Redis channel
  tagged with a per-instance id; every replica subscribes once and re-emits
  events that didn't originate locally (the origin keeps its in-process fast
  path, so local SSE latency is unchanged).

HA is therefore: **Postgres + Redis → safe with replicas > 1.** SQLite stays
explicitly single-instance (a file-backed DB isn't shared storage), so a SQLite
deployment runs one replica regardless of Redis.

Two ioredis connections are used — a `main` client for commands and a dedicated
`subscriber` (the protocol forbids regular commands on a connection in subscriber
mode) — both `globalThis` singletons so Next's per-route bundling doesn't open a
connection per bundle. Commands fail fast (`maxRetriesPerRequest: 2`) so a dead
Redis never hangs a request; ioredis reconnects in the background.

## Rationale

Making Redis optional and self-healing keeps the easy path easy (single node,
zero new infra) while making the scaled path correct. The fall-back-on-failure
behaviour means adding Redis can only improve resilience, never reduce
availability: the worst case is "back to single-node coordination semantics for a
few seconds," not an outage. Reusing the already-shared Postgres for sessions
avoids putting session state — the one thing whose loss logs everyone out — into
a cache that operators might treat as ephemeral.

The honest trade-off: with Redis down, the three coordinated behaviours silently
revert to per-replica semantics (rate limits loosen, a reveal token may only work
on its origin replica, cross-replica live updates pause). That's acceptable for a
transient blip and is logged at `warn`, but operators running replicas > 1 should
monitor Redis as a real dependency.

## Alternatives considered

- **Make Redis mandatory.** Simpler code (one path), but punishes the common
  single-node operator with infra they don't need. Rejected.
- **Postgres LISTEN/NOTIFY for the event bus + Postgres rows for tokens/limits.**
  Avoids a second datastore, but couples request-path latency to Postgres for
  high-frequency operations and makes the token-bucket hot path a DB write.
  Rejected in favour of Redis's purpose-built primitives.
- **Sticky sessions at the load balancer.** Would paper over the SSE problem only
  (not rate limits or reveal tokens) and pushes correctness into LB config the
  app can't verify. Rejected.

## Consequences

- New optional env var `REDIS_URL` (plus the existing `APP_*` set). Documented
  exhaustively in `.env.example` and the README HA section.
- The README's High availability section ships a Postgres + Redis compose example
  (`docker-compose.ha.yml`) so the HA topology is copy-paste runnable.
- Operators scaling past one replica MUST use Postgres + Redis; the README and
  `instrumentation.ts` boot log both state this. A SQLite deployment that sets
  replicas > 1 is unsupported and the boot log says so.
- Tests run with no `REDIS_URL`, exercising the in-process fall-back paths; the
  Redis paths are covered by unit tests that stub the client.

## References

- ADR-0007 (DB-backed sessions — why sessions were already shared).
- `lib/redis.ts`, `lib/auth/rate-limit.ts`, `lib/auth/temp-reveal-store.ts`,
  `lib/realtime/event-bus.ts`, `instrumentation.ts`.
