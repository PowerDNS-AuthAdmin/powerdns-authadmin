# ADR 0015 — Backend health advisories (the notification bell)

- **Status:** Accepted
- **Date:** 2026-05-23
- **Deciders:** @jseifeddine

## Context

Operators need to know when a backend is broken or mis-serving without hunting through pages. Each
poll already yields observed state: reachability (`lastSeenAt`), the capability snapshot and zone
inventory from ADR-0014, and zone serials. The hazard in any alerting system is **noise** — a bell
that cries wolf gets muted. The user's explicit constraint: this must be "logically sound and
actually beneficial rather than just noise."

## Decision

1. **Advisories are a pure function of current observed state**, recomputed every poll from the
   `BackendProfile` set (ADR-0014). Nothing is hand-raised; when the condition clears, the advisory
   disappears. The only persisted state is `firstSeenAt` / `lastSeenAt` (for debounce + age) and
   `acknowledgedAt`.
2. **Curated, severity-tiered rule set — actionable only:**
   - **ERROR** — backend unreachable past threshold; `/config` or `/servers` returns 401/403 (API
     off / wrong key); has Slave zones but `secondary=no` (they will never AXFR); a Slave zone with
     empty `masters[]`; replication **serial drift** beyond threshold between matched managed
     backends.
   - **WARN** — has Master zones but `primary=no` (no NOTIFY on change); `autosecondary=yes` with no
     autoprimaries configured, or autoprimaries present but `autosecondary=no` (capability/intent
     mismatch).
   - **INFO** — reserved, off by default.
   - No style/opinion rules (e.g. "you should sign this zone"). Signal is protected by _what we
     refuse to alert on_.
3. **Debounce.** A condition must persist ≥2 consecutive polls (or ≥ N minutes) before it counts as
   active/alerting — a single failed poll never rings the bell.
4. **Acknowledge / snooze** per `(backendId, code)`. Acked advisories drop out of the count but stay
   listed; if the advisory's detail materially changes (e.g. drift grows), the ack is invalidated
   and it re-alerts.
5. **Surfacing.** A bell in the top bar shows the unacked active count, coloured by max severity. The
   dropdown groups by backend; each row carries a one-line _why it matters_ + _how to fix_ + a deep
   link to the relevant page; live-updated over the existing SSE bus. **Permission-scoped** — a user
   only sees advisories for backends they can read.
6. **Storage.** A `backend_advisory` table upserted by `(backendId, code)` each poll (severity,
   title, detail, `firstSeenAt`, `lastSeenAt`, `acknowledgedAt`). Rows absent from the latest
   evaluation are pruned — the table self-heals.

## Rationale

Computing from current state (rather than emitting an event stream) makes the system self-clearing
and impossible to leave stale. Debounce, acknowledge, and a deliberately small rule set are the
three levers that keep it high-signal. Trade-off: serial-drift detection needs cross-backend serial
reads on the poll cycle (extra work, bounded by group membership), and some real-but-rare problems
are intentionally left out of scope to protect signal.

## Alternatives considered

- **Event-log alerting** (append a row when something breaks). Goes stale, needs manual resolution,
  and double-counts flapping conditions.
- **Per-rule thresholds exposed in the UI.** Deferred: ship sane fixed thresholds first, expose
  later if operators ask.
- **Email / webhook delivery.** Deferred to a follow-up; the in-app bell + SSE is the MVP.

## Consequences

- New `backend_advisory` table (dual dialect, boot migration per ADR-0011).
- A `HealthEvaluator` pure module + a poll-cycle hook that upserts/prunes advisories.
- A top-bar bell component fed by the SSE bus; an advisory `code` vocabulary (like the audit action
  vocabulary) that grows by append.
- Depends on ADR-0014's capability snapshot and `BackendProfile`.

## References

- ADR-0014 (capability model / `BackendProfile`)
- `lib/realtime/` (SSE event bus + zone-state poller), `lastSeenAt` reachability model
- `lib/audit/actions.ts` (precedent for an append-only code vocabulary)
