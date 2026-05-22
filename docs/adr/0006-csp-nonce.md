# ADR 0006 — Per-request CSP nonce

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

Next.js streams inline `<script>` tags as part of its server-rendered HTML — these carry the
hydration payload that React needs to take over the page. A strict Content Security Policy must
allow those inline scripts somehow.

The options are:

1. `script-src 'unsafe-inline'` — allow any inline script. Defeats most of CSP's protection.
2. `script-src 'self' 'sha256-<hash>'` — hash-pin known inline scripts. Doesn't work when the
   inline content varies per request (which it does for hydration).
3. `script-src 'self' 'nonce-<random>' 'strict-dynamic'` — issue a per-request random nonce,
   include it on every inline script tag we want to allow, trust further scripts loaded by those
   trusted ones.

## Decision

We use option 3: a **per-request nonce** generated in `middleware.ts`, propagated to Next.js'
inline scripts via the `x-nonce` request header, with `'strict-dynamic'` so we don't have to list
every chunk URL.

## Rationale

- **Real CSP, not theatre.** Options 1 and 2 produce a CSP that _exists_ but doesn't _protect_.
  Option 3 actually stops injected `<script>` tags from executing.
- **`'strict-dynamic'` keeps the policy simple.** Without it we'd have to enumerate every chunk
  URL Next produces, which changes on every build.
- **Next.js supports it natively.** Reads `x-nonce` from the request and attaches the nonce to
  its framework scripts automatically.

## Trade-offs (the honest part)

- **Every response goes through middleware.** This is a tiny per-request cost (~1ms for nonce
  generation), but it does mean CDN cacheability is reduced. Acceptable for an admin app; would
  be reconsidered for a public-facing site.
- **`crypto.getRandomValues` works in the Edge runtime,** which is where Next middleware runs.
  If we ever move middleware to Node runtime we need to verify the nonce generator still uses a
  CSPRNG.
- **CSS still uses `'unsafe-inline'`** for style-src because Tailwind injects critical CSS at
  render time. Not load-bearing for security since style injection has a much smaller attack
  surface than script injection.

## Consequences

- All inline scripts in the app must carry `nonce={nonce}` from a server component / route
  handler. Forgetting this means the script silently fails to execute.
- Browser DevTools shows the nonce on every script — that's fine; the protection comes from the
  nonce being unpredictable per request, not from being secret.
- E2E tests that inject scripts via Playwright must use Playwright's evaluation context, not
  string injection.

## References

- `middleware.ts` (the implementation)
- [Next.js CSP guide](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
- [MDN: CSP nonce-source](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
