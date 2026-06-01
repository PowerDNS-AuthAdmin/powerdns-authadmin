# ADR 0007 - DB-backed sessions over stateless JWTs

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

Web session storage breaks into two camps:

- **Stateless JWT.** All session data lives in the cookie, signed/encrypted. No DB hit per
  request.
- **Stateful (DB-backed).** Cookie carries an opaque session ID; the server looks it up on every
  request.

PowerDNS-AuthAdmin manages DNS infrastructure. A compromised session has the potential to delete
zones, exfiltrate records, or pivot through an OIDC provider. Revocation is a security
requirement, not a nice-to-have.

## Decision

Sessions are stored in the **`sessions` table** in Postgres. The cookie carries an opaque
encrypted session ID; the server looks it up on every request and validates it has not been
revoked.

## Rationale

- **Instant revocation.** When you fire an employee with zone-delete rights, "delete one DB row"
  is the right semantics. JWT denylists are a half-solution: they require a separate revocation
  cache, can't beat the JWT's own expiry without significant complexity, and force a denylist
  lookup per request anyway (so the "no DB hit" win is illusory in any real deployment).
- **Session metadata is queryable.** "Show me all active sessions for user X" is a useful admin
  feature; with JWTs you'd need a parallel index.
- **Rotation is trivial.** Change the encryption key and force re-login by truncating the table.
  Rotating a JWT signing key is messier (have to keep old keys around for in-flight tokens).
- **The DB hit cost is small.** One indexed SELECT per request. Postgres at the connection pool
  size we run can absorb this without notice.

## Trade-offs (the honest part)

- **The DB is on the hot path.** If Postgres is down, the app can't authenticate. We accept this
  - `lib/db/` is on the hot path for everything else too, so adding sessions doesn't widen the
    blast radius.
- **Horizontal scaling needs shared DB.** Already true for the rest of the app.
- **Cookie size.** The opaque encrypted session ID is ~80 bytes; a typical JWT is 400+. We win
  here, not lose.

## Consequences

- Every request that needs authentication does one indexed SELECT against `sessions`. This is
  the single biggest per-request cost.
- `sessions.expires_at` is indexed; the `session-prune` job deletes expired rows hourly.
- We track `ip`, `user_agent`, `last_seen_at` per session - useful for the "your active sessions"
  admin view and for anomaly detection.
- CSRF protection uses double-submit cookies + a `csrf_secret` field on the session row. The
  cookie isn't enough on its own because subdomains may not be isolated.

## References

- `lib/db/schema/sessions.ts` (session table)
- `lib/auth/session.ts` (cookie + session lifecycle)
