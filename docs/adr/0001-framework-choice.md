# ADR 0001 — Choose Next.js 15 + React Server Components as the framework

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jadseifeddine
- **Update (2026-05-22):** the project has since upgraded to **Next.js 16** (still App Router +
  React 19 Server Components — the decision stands; only the minor version moved).

## Context

PowerDNS-AuthAdmin is a server-rendered admin UI with a public REST API, OIDC/SAML/LDAP auth, and a
strict separation between server-only secrets and client-rendered UI. The framework choice shapes
how every contributor writes code for the next several years; we need broad community familiarity
to keep the contributor pool large.

## Decision

We will use **Next.js 15 with the App Router and React 19 Server Components** as the application
framework, with TypeScript 5.x strict mode throughout.

## Rationale

- **Contributor pool.** Next.js is the framework most TypeScript developers already know. A
  community-driven project lives or dies by drive-by contributors not having to learn a new stack
  before they can help.
- **Server Components keep secrets server-side by construction.** The PDNS API key, OIDC client
  secrets, and the encryption key never have a path to the browser. SPA + API architectures need
  separate enforcement; here it's structural.
- **Same code serves UI and REST API.** Route handlers under `/api/v1/*` and server components in
  `/app` both call the same `lib/` modules. One business-logic layer, two transports.
- **First-class streaming + Suspense** for slow PDNS queries (catalog zone members, large RRsets).
- **Stable production maturity.** App Router shipped in 2023; React 19 RSC shipped in 2024. Both
  are well past the early-adopter phase.

## Alternatives considered

- **Remix (React Router 7).** Cleaner mental model (loaders/actions), fewer footguns, but smaller
  community. Loses on the contributor-pool axis.
- **SvelteKit.** Best DX, smallest bundles, but the smallest community of the three. Picking it
  would optimize for the maintainer at the expense of contributors.
- **NestJS + standalone React SPA.** Two deploys, parallel auth flows to defend, more
  infrastructure to teach a new contributor. Rejected — server-rendered admin UIs are simpler.

## Consequences

- Every contributor needs to understand the App Router model: server vs client components, route
  handlers, server actions, the `"use client"` boundary, the `import "server-only"` directive.
- We adopt Next.js' opinionated structure (the `app/` directory layout, file-based routing,
  built-in middleware). This is largely a benefit — the structure is well-understood — but it
  limits some kinds of customization.
- The Docker image uses Next's `output: "standalone"` mode for a small, focused bundle.
- We're tied to Vercel-adjacent release cadence; major Next.js updates land every ~6 months and we
  upgrade promptly to avoid drift.

## References

- [Next.js App Router docs](https://nextjs.org/docs/app)
- [React Server Components RFC](https://github.com/reactjs/rfcs/blob/main/text/0188-server-components.md)
