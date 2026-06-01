# ADR 0013 - The PDNS client's sanctioned DB bridge (and fixing boundary enforcement)

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** @jseifeddine

## Context

ADR-0004 makes `lib/pdns/` a **pure protocol adapter**: it speaks the PowerDNS HTTP API and
nothing else. RBAC, audit, and DB writes happen in the calling business logic. The boundary was
declared as an ESLint `import/no-restricted-paths` zone (`lib/pdns` may not import `lib/db`,
`lib/rbac`, `lib/audit`, `lib/auth`).

Two things were true and in tension:

1. **The rule wasn't actually enforcing anything.** `import/no-restricted-paths` resolves an
   import to a file path and compares it against the zone's `from`/`target` directories - which
   requires an import **resolver**. The codebase imports everything via the `@/…` TS path alias,
   and no resolver was configured, so the rule never resolved `@/lib/db` to `./lib/db` and never
   fired. Four files under `lib/pdns/` had `// eslint-disable-next-line import/no-restricted-paths`
   directives that were inert - the boundary, the centerpiece of ADR-0004, was silently
   unenforced.

2. **Four files genuinely need `lib/db`.** They are bridges by nature, not accidental coupling:
   - `registry.ts` - builds a `PdnsClient` from a `pdns_servers` row (decrypts the API key, reads
     base URL/capabilities). Constructing a client _is_ reading config from the DB.
   - `request-log.ts` - writes one `pdns_requests` audit row per outbound HTTP call. It is the
     PDNS transport's own request log; the writer must touch the DB.
   - `cluster-picker.ts` - `choosePeer()` reads recent `metric_samples` to apply a latency/zone
     count routing strategy. The pure decision lives in `cluster-picker-pure.ts`; this file only
     loads the samples that feed it.
   - `sync.ts` - cross-server zone-state coordination; enumerates a primary's active secondaries
     (a DB read) and fans probes across them.

## Decision

1. **Enforce the boundary for real.** Replace `import/no-restricted-paths` with
   `no-restricted-imports` `patterns` (matched against the import **specifier**, e.g.
   `@/lib/db/**`), scoped per layer via flat-config `files` overrides. This works with the `@/`
   alias and needs no resolver. The zones from ADR-0004 are preserved: `components/**` ✗ db/pdns/auth,
   `lib/db/**` ✗ rbac, `lib/pdns/**` ✗ rbac/audit/db/auth.

2. **Sanction the four bridge files explicitly.** Each carries a file-top
   `/* eslint-disable no-restricted-imports */` with a comment pointing here. The disable is now
   _real_ (the rule fires) and _narrow_ (only these four files), so the exception is visible in
   review and greppable, instead of an inert directive hiding an unenforced rule.

## Rationale

- The bridge files are a small, stable, conceptually-coherent set: "turn a DB server/cluster row
  into PDNS traffic, and log that traffic back." Forcing the DB reads up into every call site
  would duplicate `loadSamples`/`listActiveSecondariesForPrimary` across 4–5 callers each - worse
  coupling, not better.
- Making the rule actually fire is the important correction: any _new_ `lib/pdns → lib/db` import
  now fails CI unless it's a deliberate, reviewed addition to a bridge file.

## Alternatives considered

- **Add `eslint-import-resolver-typescript`** so `import/no-restricted-paths` resolves `@/`.
  Rejected for now: a new lint dependency + resolver config to keep a rule that
  `no-restricted-imports` does specifier-side with zero deps.
- **Invert the dependencies** (pass samples / secondary lists into `lib/pdns` from above).
  Clean in principle and still the long-term goal for `cluster-picker`/`sync`, but it duplicates
  the DB reads across call sites today and touches load-bearing routing code. Deferred as future
  work; tracked in the file-top comments.

## Consequences

- The three-layer boundary from ADR-0004 is now genuinely enforced (it previously was not).
- The `lib/pdns → lib/db` coupling is confined to four named files and documented here.
- Future work: relocate `cluster-picker.choosePeer` and `sync.ts` above `lib/pdns` (e.g. a
  `lib/cluster/` domain module) and drop their disables, leaving `registry`/`request-log` as the
  irreducible bridge.

## References

- ADR-0004 (the three-layer architecture this refines)
- `eslint.config.mjs` (the enforcement)
- `lib/pdns/{registry,request-log,cluster-picker,sync}.ts` (the bridge)
